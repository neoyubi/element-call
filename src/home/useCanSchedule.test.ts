import { act, renderHook } from "@testing-library/react";
import {
  KnownMembership,
  type MatrixClient,
  type Room,
  RoomEvent,
} from "matrix-js-sdk";
import EventEmitter from "events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockConfig } from "../utils/test";
import { useCanSchedule } from "./useCanSchedule";

const SCHEDULERS_ROOM = "!schedulers:example.org";

function fakeClient(membership?: KnownMembership): {
  client: MatrixClient;
  emitter: EventEmitter;
  off: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  let current = membership;
  const off = vi.fn((event: string, handler: () => void) => {
    emitter.off(event, handler);
  });
  const client = {
    getRoom: (roomId: string): Room | null =>
      roomId === SCHEDULERS_ROOM && current !== undefined
        ? ({ getMyMembership: () => current } as unknown as Room)
        : null,
    on: (event: string, handler: () => void) => emitter.on(event, handler),
    off,
    setMembership: (next: KnownMembership) => {
      current = next;
    },
  } as unknown as MatrixClient & {
    setMembership: (m: KnownMembership) => void;
  };
  return { client, emitter, off };
}

afterEach(() => vi.restoreAllMocks());

describe("useCanSchedule", () => {
  it("is false when no scheduling room is configured", () => {
    mockConfig({});
    const { client } = fakeClient(KnownMembership.Join);
    const { result } = renderHook(() => useCanSchedule(client));
    expect(result.current).toBe(false);
  });

  it("is false when the user is only invited", () => {
    mockConfig({ schedulers_room_id: SCHEDULERS_ROOM });
    const { client } = fakeClient(KnownMembership.Invite);
    const { result } = renderHook(() => useCanSchedule(client));
    expect(result.current).toBe(false);
  });

  it("is false when the user has left", () => {
    mockConfig({ schedulers_room_id: SCHEDULERS_ROOM });
    const { client } = fakeClient(KnownMembership.Leave);
    const { result } = renderHook(() => useCanSchedule(client));
    expect(result.current).toBe(false);
  });

  it("is true when the user has joined", () => {
    mockConfig({ schedulers_room_id: SCHEDULERS_ROOM });
    const { client } = fakeClient(KnownMembership.Join);
    const { result } = renderHook(() => useCanSchedule(client));
    expect(result.current).toBe(true);
  });

  it("follows a membership change", () => {
    mockConfig({ schedulers_room_id: SCHEDULERS_ROOM });
    const { client, emitter } = fakeClient(KnownMembership.Leave);
    const { result } = renderHook(() => useCanSchedule(client));
    expect(result.current).toBe(false);

    act(() => {
      (
        client as MatrixClient & { setMembership: (m: KnownMembership) => void }
      ).setMembership(KnownMembership.Join);
      emitter.emit(RoomEvent.MyMembership);
    });
    expect(result.current).toBe(true);
  });

  it("stops listening when unmounted", () => {
    mockConfig({ schedulers_room_id: SCHEDULERS_ROOM });
    const { client, off } = fakeClient(KnownMembership.Join);
    const { unmount } = renderHook(() => useCanSchedule(client));
    unmount();
    expect(off).toHaveBeenCalledWith(
      RoomEvent.MyMembership,
      expect.any(Function),
    );
  });
});
