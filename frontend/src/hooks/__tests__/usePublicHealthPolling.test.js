/**
 * @jest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react";
import { usePublicHealthPolling } from "../usePublicHealthPolling";

// Issue #1831 — the public pay page polls with back-off instead of SSE.

const okResponse = { ok: true };
const badResponse = { ok: false };

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("usePublicHealthPolling", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("stays connected while the endpoint answers", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse);
    const { result } = renderHook(() => usePublicHealthPolling({ fetchImpl, intervalMs: 1000 }));
    await flush();
    expect(result.current.connectionStatus).toBe("connected");
    expect(result.current.degraded).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/public-config");
  });

  it("does not show the banner after a single failure", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(badResponse).mockResolvedValue(okResponse);
    const { result } = renderHook(() => usePublicHealthPolling({ fetchImpl, intervalMs: 1000 }));
    await flush();
    expect(result.current.connectionStatus).toBe("connected");
  });

  it("shows the banner after three consecutive failures and recovers on success", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(okResponse);
    const { result } = renderHook(() =>
      usePublicHealthPolling({ fetchImpl, intervalMs: 1000, maxIntervalMs: 60000 })
    );
    await flush(); // failure 1 → retry after 1 s
    await act(async () => { jest.advanceTimersByTime(1000); });
    await flush(); // failure 2 → retry after 2 s
    expect(result.current.connectionStatus).toBe("connected");
    await act(async () => { jest.advanceTimersByTime(2000); });
    await flush(); // failure 3 → banner
    expect(result.current.connectionStatus).toBe("reconnecting");
    await act(async () => { jest.advanceTimersByTime(4000); });
    await flush(); // success → back to connected
    expect(result.current.connectionStatus).toBe("connected");
  });

  it("caps the back-off delay at maxIntervalMs", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(badResponse);
    renderHook(() =>
      usePublicHealthPolling({ fetchImpl, intervalMs: 1000, maxIntervalMs: 4000 })
    );
    await flush(); // call 1 → 1 s
    await act(async () => { jest.advanceTimersByTime(1000); }); await flush(); // call 2 → 2 s
    await act(async () => { jest.advanceTimersByTime(2000); }); await flush(); // call 3 → 4 s
    await act(async () => { jest.advanceTimersByTime(4000); }); await flush(); // call 4 → capped 4 s
    await act(async () => { jest.advanceTimersByTime(4000); }); await flush(); // call 5
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("does not poll when disabled", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse);
    renderHook(() => usePublicHealthPolling({ enabled: false, fetchImpl }));
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pauses while hidden and resumes when visible again", async () => {
    let visibility = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const fetchImpl = jest.fn().mockResolvedValue(okResponse);
    renderHook(() => usePublicHealthPolling({ fetchImpl, intervalMs: 1000 }));
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
