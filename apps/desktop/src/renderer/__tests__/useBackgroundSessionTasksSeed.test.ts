// @vitest-environment jsdom

/**
 * useBackgroundSessionTasks 快照水合接线:候选集在发起 IPC 前捕获并透传给
 * seedBackgroundTaskSnapshots(stale running 对账);空快照 + 空候选不打扰
 * store。
 *
 * device-link 远程镜像会话同样拉快照 —— 路由交给 listSessionBackgroundTasksFor
 * (按粘滞归属决定本机 IPC 还是隧道;路由本身在 makerTransportStopRouting 覆盖),
 * 本 hook 只负责「远程也不关闭运行集信号」+「粘滞远程只 seed 不对账」。
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureReconcilableRunningTaskIds: vi.fn((): ReadonlySet<string> => new Set<string>()),
  seedBackgroundTaskSnapshots: vi.fn(),
  // 粘滞判定可独立标记:覆盖「非粘滞误判本机、粘滞仍认远程」的重连窗口分支。
  stickyRemoteIds: new Set<string>(),
  // 镜像来源证据(owner token):归属不可解析时的 fail closed 分支。
  mirrorOwnerTokenIds: new Set<string>(),
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    captureReconcilableRunningTaskIds: mocks.captureReconcilableRunningTaskIds,
    seedBackgroundTaskSnapshots: mocks.seedBackgroundTaskSnapshots,
  },
}));

const transport = vi.hoisted(() => ({
  listSessionBackgroundTasksFor: vi.fn(),
  stopAgentTaskFor: vi.fn(),
}));

vi.mock('@/lib/makerTransport', () => ({
  isRemoteSession: (sessionId: string) => sessionId.startsWith('remote-'),
  isRemoteSessionSticky: (sessionId: string) =>
    sessionId.startsWith('remote-') || mocks.stickyRemoteIds.has(sessionId),
  listSessionBackgroundTasksFor: transport.listSessionBackgroundTasksFor,
  stopAgentTaskFor: transport.stopAgentTaskFor,
}));

// 本地构建桥接 readRoutedBackgroundTasks 的依赖:粘滞归属解析 + 镜像来源证据 + 隧道调用。
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: (sessionId: string) =>
    sessionId.startsWith('remote-') || mocks.stickyRemoteIds.has(sessionId) ? 'dev-1' : undefined,
}));

vi.mock('@/features/device-link/mirrorCacheClient', () => ({
  knownOwnerTokenFor: (sessionId: string) => mocks.mirrorOwnerTokenIds.has(sessionId) ? 'tok' : undefined,
}));

import { useBackgroundSessionTasks } from '@/hooks/useBackgroundSessionTasks';

describe('useBackgroundSessionTasks 快照水合 + 对账接线', () => {
  let listTasks: ReturnType<typeof vi.fn>;
  let invokeRemote: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // clearAllMocks 不清 mockReturnValue,显式回位空候选集,避免用例间串状态。
    mocks.captureReconcilableRunningTaskIds.mockReturnValue(new Set<string>());
    listTasks = vi.fn(async () => ({ tasks: [] }));
    // 隧道调用汇入同一个 listTasks(远程与本地在断言上可分辨 channel / args)。
    invokeRemote = vi.fn(async (_deviceId: string, _channel: string, args: unknown[]) =>
      listTasks((args as string[])[0]),
    );
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: { listSessionBackgroundTasks: listTasks },
      deviceLink: { invoke: invokeRemote },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    mocks.stickyRemoteIds.clear();
    mocks.mirrorOwnerTokenIds.clear();
    vi.clearAllMocks();
  });

  it('镜像来源但归属不可解析(unknown):fail closed,不回退本机读', async () => {
    mocks.mirrorOwnerTokenIds.add('mirror-2');
    mocks.captureReconcilableRunningTaskIds.mockReturnValue(new Set(['t-mirror']));
    renderHook(() => useBackgroundSessionTasks('mirror-2', new Map(), true));
    await Promise.resolve();
    // 回退本机读的话，控制端 main 的空表会被当权威快照收口，把仍在被控端运行的
    // 任务标成 stopped(任务从运行列表与停止入口消失)。
    expect(listTasks).not.toHaveBeenCalled();
    expect(invokeRemote).not.toHaveBeenCalled();
    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();
  });

  it('候选集在发起 IPC 前捕获,空快照 + 非空候选仍触发 seed(对账信号)', async () => {
    const candidates = new Set(['t-stale']);
    mocks.captureReconcilableRunningTaskIds.mockReturnValue(candidates);

    renderHook(() => useBackgroundSessionTasks('s1', new Map(), true));

    await waitFor(() => {
      expect(mocks.seedBackgroundTaskSnapshots).toHaveBeenCalledWith('s1', [], {
        staleRunningCandidates: candidates,
      });
    });
    // 捕获必须先于 IPC 发起(时序契约:请求在飞窗口内新启动的任务不得进候选集)
    expect(mocks.captureReconcilableRunningTaskIds.mock.invocationCallOrder[0]).toBeLessThan(
      listTasks.mock.invocationCallOrder[0],
    );
  });

  it('空快照 + 空候选:不打扰 store', async () => {
    renderHook(() => useBackgroundSessionTasks('s2', new Map(), true));
    await waitFor(() => expect(listTasks).toHaveBeenCalled());
    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();
  });

  it('远程镜像会话:权威快照可收口 stale running(含 hook 运行集里的 PI 命令)', async () => {
    mocks.captureReconcilableRunningTaskIds.mockReturnValue(new Set(['t-claude']));
    renderHook(() => useBackgroundSessionTasks('remote-s3', new Map(), true));
    await waitFor(() =>
      expect(invokeRemote).toHaveBeenCalledWith('dev-1', 'maker:session-background-tasks:list', [
        'remote-s3',
      ]),
    );
    // 权威远程空快照 + 非空候选 → 必须收口:否则被控端已停而镜像终态丢包时,
    // 控制端会永久保留 running 并反复提供「全部停止」。
    await waitFor(() =>
      expect(mocks.seedBackgroundTaskSnapshots).toHaveBeenCalledWith('remote-s3', [], {
        staleRunningCandidates: new Set(['t-claude']),
      }),
    );
  });

  it('远程降级空表(读取失败)不可当权威:只 seed 不收口', async () => {
    mocks.captureReconcilableRunningTaskIds.mockReturnValue(new Set(['t-mirror']));
    invokeRemote.mockRejectedValueOnce(new Error('DEVICE_LINK_CHANNEL_NOT_ALLOWED'));
    renderHook(() => useBackgroundSessionTasks('remote-s6', new Map(), true));
    await waitFor(() => expect(invokeRemote).toHaveBeenCalled());
    await Promise.resolve();
    // 老被控端无 channel / 隧道失败与「确实没有任务」不可区分 → 不得收口。
    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();
  });

  it('在飞窗口:响应落地前会话被识别为远程 → 整体丢弃本机快照,不收口', async () => {
    const sid = 's5-inflight';
    mocks.captureReconcilableRunningTaskIds.mockReturnValue(new Set(['t-mirror']));
    let resolveList!: (v: { tasks: unknown[] }) => void;
    listTasks.mockReturnValue(
      new Promise((r) => {
        resolveList = r;
      }),
    );

    renderHook(() => useBackgroundSessionTasks(sid, new Map(), true));
    await waitFor(() => expect(listTasks).toHaveBeenCalledWith(sid));

    // 请求在飞期间远程注册表完成会话水合
    mocks.stickyRemoteIds.add(sid);
    resolveList({ tasks: [] });
    await waitFor(() => expect(listTasks).toHaveBeenCalled());
    await Promise.resolve();

    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();
  });

  it('重连窗口(非粘滞误判本机、粘滞仍认远程):归属不符整体丢弃,归属一致才收口', async () => {
    const sid = 's4-blip';
    mocks.captureReconcilableRunningTaskIds.mockReturnValue(new Set(['t-mirror-running']));

    // 请求发起时还认本机(路由按本机定),响应落地前才水合成远程 → 整体丢弃
    let resolveLocal!: (v: { tasks: unknown[] }) => void;
    listTasks.mockReturnValueOnce(
      new Promise((r) => {
        resolveLocal = r;
      }),
    );
    renderHook(() => useBackgroundSessionTasks(sid, new Map(), true));
    await waitFor(() => expect(listTasks).toHaveBeenCalledWith(sid));
    mocks.stickyRemoteIds.add(sid);
    resolveLocal({ tasks: [] });
    await Promise.resolve();
    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();

    // 归属一致的远程快照:非空照旧 seed,且带候选集(可收口 stale running)
    listTasks.mockResolvedValueOnce({ tasks: [{ taskId: 't-new' }] });
    renderHook(() => useBackgroundSessionTasks(sid, new Map(), false));
    await waitFor(() => expect(invokeRemote).toHaveBeenCalled());
    await waitFor(() =>
      expect(mocks.seedBackgroundTaskSnapshots).toHaveBeenCalledWith(
        sid,
        [{ taskId: 't-new' }],
        { staleRunningCandidates: new Set(['t-mirror-running']) },
      ),
    );
  });
});
