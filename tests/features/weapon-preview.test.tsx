import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWeaponPreview } from "../../src/features/modding/use-weapon-preview";
import type { BuildNode } from "../../src/types/weapon-modding";

const root: BuildNode = { instanceId: "weapon:abc", itemId: "5447a9cd4bdc2dbd208b4567", children: [] };
const firstImage = "data:image/png;base64,aGVsbG8=";
const nextImage = "data:image/png;base64,d29ybGQ=";
function Probe({ node = root, enabled = false, angle = 0 }: { node?: BuildNode; enabled?: boolean; angle?: -30 | 0 | 30 }) {
  const preview = useWeaponPreview(node, enabled, angle);
  return <><p>{preview.status}</p><p>{preview.error}</p>{preview.imageUrl && <img alt="조립 결과" src={preview.imageUrl} />}
    <button onClick={preview.retry}>재시도</button></>;
}
function result(imageUrl = firstImage) { return new Response(JSON.stringify({ imageUrl }), { headers: { "Content-Type": "application/json" } }); }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(1_500); }); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("assembled weapon preview", () => {
  it("makes no request without opt-in and debounces enabled changes", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(() => Promise.resolve(result())); vi.stubGlobal("fetch", fetcher);
    const view = render(<Probe />); await tick(); expect(fetcher).not.toHaveBeenCalled();
    view.rerender(<Probe enabled />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); expect(fetcher).not.toHaveBeenCalled();
    await tick(); expect(screen.getByRole("img", { name: "조립 결과" })).toHaveAttribute("src", firstImage);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ root, angle: 0 });
  });
  it("immediately hides the previous build image and sends the changed angle", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(() => Promise.resolve(result())); vi.stubGlobal("fetch", fetcher);
    const view = render(<Probe enabled />); await tick();
    view.rerender(<Probe enabled angle={30} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await tick(); expect(JSON.parse(fetcher.mock.calls[1][1].body).angle).toBe(30);
  });
  it("does not let an obsolete response replace the current build and serializes requests", async () => {
    vi.useFakeTimers(); let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockImplementation(() => Promise.resolve(result(nextImage))); vi.stubGlobal("fetch", fetcher);
    const view = render(<Probe enabled />); await tick();
    view.rerender(<Probe enabled node={{ ...root, children: [{ instanceId: "part", itemId: "55802f5d4bdc2dac148b458f", slotId: "55d354084bdc2d8c2f8b4568", children: [] }] }} />);
    await tick(); expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { finish(result()); });
    expect(screen.getByRole("img")).toHaveAttribute("src", nextImage);
  });
  it("shows a local error and never retries a failed request automatically", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "untrusted text" } }), { status: 429, headers: { "Content-Type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
    render(<Probe enabled />); await tick();
    expect(screen.getByText(/호출 제한/)).toBeInTheDocument(); expect(screen.queryByText("untrusted text")).not.toBeInTheDocument();
    await tick(); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(() => Promise.resolve(result())); fireEvent.click(screen.getByRole("button", { name: "재시도" })); await tick();
    expect(screen.getByRole("img")).toBeInTheDocument();
  });
  it("rejects unexpected remote URLs and clears the preview when disabled", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(() => Promise.resolve(result("https://untrusted.test/image.svg"))); vi.stubGlobal("fetch", fetcher);
    const view = render(<Probe enabled />); await tick(); expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/응답을 확인/)).toBeInTheDocument(); view.rerender(<Probe />); await tick();
    expect(screen.getByText("off")).toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("stops queued opt-in work when disabled and ignores an already dispatched response", async () => {
    vi.useFakeTimers(); let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockImplementation(() => Promise.resolve(result(nextImage))); vi.stubGlobal("fetch", fetcher);
    const view = render(<Probe enabled />); await tick();
    view.rerender(<Probe enabled angle={30} />); await tick();
    view.rerender(<Probe angle={30} />);
    await act(async () => { finish(result()); }); await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("off")).toBeInTheDocument();
    view.rerender(<Probe enabled angle={30} />); await tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("img")).toHaveAttribute("src", nextImage);
  });
  it("skips obsolete queued angles instead of generating each intermediate change", async () => {
    vi.useFakeTimers(); let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockImplementation(() => Promise.resolve(result(nextImage))); vi.stubGlobal("fetch", fetcher);
    const view = render(<Probe enabled />); await tick();
    view.rerender(<Probe enabled angle={-30} />); await tick();
    view.rerender(<Probe enabled angle={30} />); await tick();
    await act(async () => { finish(result()); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).angle).toBe(30);
    expect(screen.getByRole("img")).toHaveAttribute("src", nextImage);
  });
  it("releases the serialized request after a 35-second timeout so the newest build can proceed", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementationOnce((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })).mockImplementation(() => Promise.resolve(result(nextImage))); vi.stubGlobal("fetch", fetcher);
    const view = render(<Probe enabled />); await tick();
    view.rerender(<Probe enabled angle={30} />); await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(33_500); });
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("img")).toHaveAttribute("src", nextImage);
  });
  it("serializes only permitted tree fields, not attached profile or log metadata", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(() => Promise.resolve(result())); vi.stubGlobal("fetch", fetcher);
    const node = { ...root, profileName: "private profile", applicationLog: "private log", children: [{
      instanceId: "part", itemId: "55802f5d4bdc2dac148b458f", slotId: "55d354084bdc2d8c2f8b4568", children: [], notes: "private notes",
    }] };
    render(<Probe enabled node={node} />); await tick();
    const body = fetcher.mock.calls[0][1].body;
    expect(body).not.toContain("private");
    expect(JSON.parse(body)).toEqual({ root: { ...root, children: [{
      instanceId: "part", itemId: "55802f5d4bdc2dac148b458f", slotId: "55d354084bdc2d8c2f8b4568", children: [],
    }] }, angle: 0 });
  });
});
