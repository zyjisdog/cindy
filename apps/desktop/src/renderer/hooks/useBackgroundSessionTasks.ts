/**
 * useBackgroundSessionTasks —— 会话内「仍在运行、且可逐个精确停止」的后台任务
 * 的响应式列表 + 一键全停,以及给状态栏用的分类计数。
 *
 * 覆盖范围:
 * - claude-code 的 `local_bash`(run_in_background 的 Bash):不调模型,点不亮
 *   useSessionBackgroundActivity 的 loopback proxy 活动信号,必须由本 hook 从
 *   taskUpdates(agent_task_update 事件流)折算;
 * - pi 的 `local_bash`(Cindy 覆盖的 bash + background:true)与 `pi_subagent`
 *   (async durable run):两者都能经 maker:agent-task:stop 精确停止;PI 没有
 *   proxy 活动信号,子代理的后台存在感也由本 hook 提供。
 *
 * 与 useSessionBackgroundActivity 互补:那边的信号源是「CC 子进程仍在调模型」,
 * 语义是「关常驻子进程止损」;本 hook 的 stopAll 是逐个停任务,不碰会话进程。
 *
 * 快照水合:挂载 / 历史重载后用 main 的 listSessionBackgroundTasks 补回
 * 「订阅前已启动 / reloadMessages 清空」的存量任务(store 侧只补未见过的条目,
 * 不会复活已终态任务),同一份快照兼做 claude-code stale running 对账。
 *
 * 注意:这里的折算是纯 UI 信号,不参与 makerChatStore 的 running 语义(local_bash
 * 不折算 running 的既有决策不变 —— dev server 不能把会话 spinner 永转)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { makerChatStore } from '@/lib/makerChatStore';
import type { AgentTaskUpdate } from '@/lib/makerChatStore';
import {
  isRemoteSessionSticky,
  stopAgentTaskFor,
} from '@/lib/makerTransport';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { knownOwnerTokenFor } from '@/features/device-link/mirrorCacheClient';

type BackgroundTaskSnapshot = Awaited<
  ReturnType<typeof window.electronAPI.maker.listSessionBackgroundTasks>
>;

/**
 * 本地构建桥接(待 #4804 合并上游后改用 makerTransport.readSessionBackgroundTasks):
 * 按粘滞归属读一次后台任务快照,并标注来源 —— 'local' / 'remote' 是权威快照,
 * null 是降级空表(老被控端无 channel / 隧道失败 / 本机 IPC 失败)。
 *
 * 收口 stale running 只允许用权威快照:降级空表与「确实没有任务」不可区分,
 * 拿它收口会把镜像里真实在跑的任务错误停掉。
 */
async function readRoutedBackgroundTasks(sessionId: string): Promise<{
  tasks: BackgroundTaskSnapshot['tasks'];
  source: 'local' | 'remote' | null;
}> {
  const deviceId = getStickySessionDeviceId(sessionId);
  if (!deviceId) {
    // 归属不可解析、但已确认是镜像来源（受保护镜像读记下的 owner token；本机会话
    // 永不经过那条路）→ **fail closed**，绝不回退本机读：控制端 main 对不属于自己
    // 的会话会返回空表，而调用方会把它当权威快照去收口 stale running，把仍在被控端
    // 运行的任务标成 stopped。与 stopRouteFor 的 unknown 态同口径：宁可漏收。
    if (knownOwnerTokenFor(sessionId) !== undefined) {
      return { tasks: [], source: null };
    }
    try {
      const snapshot = await window.electronAPI.maker.listSessionBackgroundTasks(sessionId);
      return { tasks: snapshot.tasks, source: 'local' };
    } catch {
      return { tasks: [], source: null };
    }
  }
  try {
    const snapshot = (await window.electronAPI.deviceLink.invoke(
      deviceId,
      'maker:session-background-tasks:list',
      [sessionId],
    )) as BackgroundTaskSnapshot;
    return { tasks: snapshot.tasks, source: 'remote' };
  } catch {
    return { tasks: [], source: null };
  }
}

export interface RunningBackgroundTask {
  taskId: string;
  title?: string;
  /** 'bash' = 后台命令(local_bash);'subagent' = PI durable subagent。 */
  kind: 'bash' | 'subagent';
}

/**
 * 统计「上一轮停不下来、且现在还在运行集里」的条数(纯函数,供单测)。
 *
 * 取交集是刻意的:失败项稍后真的停了(重试成功 / 进程自然退出)时,状态栏的提示必须
 * 自动消失,而不是一直挂到下一次点击。
 */
export function countUnconfirmedRunningTasks(
  failedIds: ReadonlySet<string>,
  tasks: readonly { taskId: string }[],
): number {
  if (failedIds.size === 0 || tasks.length === 0) return 0;
  let count = 0;
  for (const task of tasks) {
    if (failedIds.has(task.taskId)) count += 1;
  }
  return count;
}

/**
 * 从 `Promise.allSettled` 的结果里挑出**停不下来**的 taskId(纯函数,供单测)。
 *
 * 只有当 host 在 SIGKILL 之后仍未确认退出时才 reject,所以这里的失败项就是
 * 「点了停止、但进程可能还在跑」—— 状态栏必须把它显示出来,不能当作全部成功。
 */
export function selectFailedStopTaskIds(
  targets: readonly { taskId: string }[],
  results: readonly PromiseSettledResult<unknown>[],
): Set<string> {
  const failed = new Set<string>();
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const taskId = targets[index]?.taskId;
    if (taskId) failed.add(taskId);
  });
  return failed;
}

/**
 * 从 taskUpdates 折算「仍在运行、且可逐个精确停止」的后台任务(纯函数,供单测)。
 * Map 里同一任务按 taskId / parentToolUseId 存成别名键(同值),此处按 taskId 收敛成一条。
 *
 * 刻意不收:codex(没有 stopTask 通道,列出来也停不掉)、claude-code 的后台子代理
 * (由 proxy 活动信号 + 会话级止损承载,本 hook 只做逐任务停止)。
 */
export function listRunningBackgroundTasks(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
): RunningBackgroundTask[] {
  if (!taskUpdates || taskUpdates.size === 0) return [];
  const out = new Map<string, RunningBackgroundTask>();
  for (const update of taskUpdates.values()) {
    if (update.status !== 'running') continue;
    let kind: RunningBackgroundTask['kind'] | undefined;
    if (update.provider === 'claude-code' && update.taskType === 'local_bash') {
      kind = 'bash';
    } else if (
      update.provider === 'pi'
      && (update.taskType === 'local_bash' || update.taskType === 'pi_subagent')
    ) {
      kind = update.taskType === 'local_bash' ? 'bash' : 'subagent';
    }
    if (!kind || out.has(update.taskId)) continue;
    out.set(update.taskId, {
      taskId: update.taskId,
      kind,
      ...(update.title ? { title: update.title } : {}),
    });
  }
  return [...out.values()];
}

export function useBackgroundSessionTasks(
  sessionId: string | undefined,
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  /** historyLoaded 翻 true 时重新水合(reloadMessages 会清空 taskUpdates 再重载)。 */
  historyLoaded?: boolean,
): {
  tasks: RunningBackgroundTask[];
  /** 后台命令数量(状态栏「N 个后台命令运行中」文案用)。 */
  bashCount: number;
  /**
   * 上一轮「全部停止」里 host 未能确认停掉的 taskId 集合。
   * host 只在 SIGKILL 之后仍未确认退出时才让单条 stop 失败 —— 空集才代表全部停掉。
   */
  stopFailedIds: ReadonlySet<string>;
  /**
   * 上一条与**当前运行集**的交集大小(状态栏提示用):任务稍后真停了就自动归零。
   */
  stopUnconfirmedCount: number;
  /** PI durable subagent 数量(仅用于状态栏守卫;文案用通用「后台任务运行中」)。 */
  subagentCount: number;
  stopping: boolean;
  stopAll: () => Promise<void>;
} {
  const [stopping, setStopping] = useState(false);
  // 快照重拉信号:远程镜像会话的终态事件可能丢包(镜像事件流有设计内丢失窗口),
  // 停止动作完成后用一次快照把「已不在跑」的对账回来 —— 本机会话走事件流 + 本地
  // 对账即可,这里只是多一次幂等 seed(seed 仅补缺,不复活已终态任务)。
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0);

  // device-link 镜像会话:任务真身在被控端,快照/停止都按粘滞归属隧道。粘滞判定
  // (而非瞬时归属)保证 relay 瞬断窗口内不把远程会话误判成本机 —— 那条路径上本机
  // 快照必空、本地 stop 会假成功。
  const remoteSticky = Boolean(sessionId) && isRemoteSessionSticky(sessionId as string);

  // 快照水合:挂载 / 切会话 / 历史重载完成后拉一次存量(远程走隧道)。maker 未 init
  // 等瞬态失败保持现状 —— 实时事件流仍会自然补上。
  // 同一次快照兼做 stale running 对账:候选集必须在**发起请求前**捕获(时序论证
  // 见 store 的 reconcileStaleRunningTasks)。候选集总是捕获:远程会话额外并入
  // hook 当前运行集里的条目(store 的 capture 只覆盖 claude-code,而被控端自
  // #4700 起也能停 PI 后台命令 —— 不收进候选集这些行就永远收口不掉)。
  // 收口只允许用**权威快照**(source !== null):降级空表不可与「没有任务」区分;
  // 响应来源与当下粘滞归属不符(归属在请求在飞期间才水合)时整体丢弃。
  useEffect(() => {
    if (!sessionId) return;
    if (!window.electronAPI?.maker?.listSessionBackgroundTasks) return;
    let disposed = false;
    const staleRunningCandidates = new Set(
      makerChatStore.captureReconcilableRunningTaskIds(sessionId),
    );
    if (isRemoteSessionSticky(sessionId)) {
      for (const task of tasksRef.current) staleRunningCandidates.add(task.taskId);
    }
    void readRoutedBackgroundTasks(sessionId)
      .then(({ tasks, source }) => {
        if (disposed || !Array.isArray(tasks)) return;
        if ((source === 'remote') !== isRemoteSessionSticky(sessionId)) return;
        const candidates =
          source === null || staleRunningCandidates.size === 0
            ? undefined
            : staleRunningCandidates;
        if (tasks.length === 0 && !candidates) return;
        makerChatStore.seedBackgroundTaskSnapshots(
          sessionId,
          tasks,
          candidates ? { staleRunningCandidates: candidates } : undefined,
        );
      })
      .catch(() => {
        // 静默:与 useSessionBackgroundActivity 的快照失败同口径(失败不对账)。
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, historyLoaded, snapshotRefreshNonce]);

  const tasks = useMemo(() => listRunningBackgroundTasks(taskUpdates), [taskUpdates]);
  const bashCount = useMemo(() => tasks.filter((task) => task.kind === 'bash').length, [tasks]);
  const subagentCount = tasks.length - bashCount;

  // 上一轮「全部停止」里停不下来的 taskId(空集 = 全部确认停掉)。下一轮点击开始时重置。
  const [stopFailedIds, setStopFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  // 切会话必须清:同一组件实例上 sessionId 只是 prop,状态会跨会话留下 —— 上个会话的
  // 「未确认 N 个」会挂到新会话的状态栏上,而在飞的 stopAll 落账时还可能写错会话。
  useEffect(() => {
    setStopFailedIds(new Set());
    setStopping(false);
  }, [sessionId]);
  // stopAll 读 ref 而非闭包列表:按钮点击时以最新运行集为准,避免陈旧闭包重复停。
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // 在飞 stopAll 的会话代际:上面那个重置 effect 只能清「切换时刻」的状态,拦不住
  // await 期间切会话后旧结果落账(会把上个会话的失败集/stopping 写进新会话)。
  const stopAllSessionRef = useRef(sessionId);
  stopAllSessionRef.current = sessionId;

  const stopAll = useCallback(async () => {
    if (!sessionId) return;
    const targets = tasksRef.current;
    if (targets.length === 0) return;
    const requestedSessionId = sessionId;
    setStopFailedIds(new Set());
    setStopping(true);
    try {
      // 逐个停,单个失败不拦其余;成功与否都交给 task_notification / durable status
      // 事件流收口,这里不改本地状态(单一事实源)。
      const results = await Promise.allSettled(
        targets.map((t) => stopAgentTaskFor(sessionId, t.taskId)),
      );
      // 失败(host 只在 SIGKILL 之后仍未确认退出时让 stop 失败)不能吞:否则用户以为
      // 「全部停止」生效了,而那条进程还在跑。失败的 taskId 交给状态栏提示,成功的
      // 部分照样触发一次自愈对账(其中可能有 main 侧其实已不在的僵尸行)。
      const failed = selectFailedStopTaskIds(targets, results);
      // 期间切了会话就整个丢弃:这些 taskId 属于上一个会话,落账会污染新会话的提示。
      if (stopAllSessionRef.current !== requestedSessionId) return;
      setStopFailedIds(failed);
      // 无论成功几条都对一次账:全失败时同样是「僵尸行 + 顽固进程」混杂、最需要快照
      // 仲裁的情形(对账只收口快照里已经没有的行,对仍在跑的行是无害确认)。
      // 远程镜像会话没有本地 handle:本地对账是 no-op,改用重拉一次隧道快照
      // (被控端可能已收口,而镜像事件丢了那条终态)。
      if (isRemoteSessionSticky(requestedSessionId)) {
        setSnapshotRefreshNonce((n) => n + 1);
      } else {
        makerChatStore.requestBackgroundTaskReconcile(requestedSessionId);
      }
    } finally {
      if (stopAllSessionRef.current === requestedSessionId) setStopping(false);
    }
  }, [sessionId]);

  // 只报「还在当前运行集里、且上一轮停不下来」的条数:失败项稍后真的停了(重试成功 /
  // 自然退出)时提示自动消失,不必等下一次点击。
  const stopUnconfirmedCount = useMemo(
    () => countUnconfirmedRunningTasks(stopFailedIds, tasks),
    [stopFailedIds, tasks],
  );

  return {
    tasks,
    bashCount,
    subagentCount,
    stopping,
    stopAll,
    stopFailedIds,
    stopUnconfirmedCount,
  };
}
