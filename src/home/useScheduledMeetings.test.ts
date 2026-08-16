import { act, renderHook } from "@testing-library/react";
import { type MatrixClient, type Room, RoomEvent } from "matrix-js-sdk";
import EventEmitter from "events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockConfig } from "../utils/test";
import {
  cancelMeeting,
  rescheduleMeeting,
  useScheduledMeetings,
} from "./useScheduledMeetings";

const ME = "@me:example.org";
const DEFAULT_TYPE = "io.element.call.scheduled_meeting";
const ADMIN_API = "https://admin-api.example.org";

interface RoomOptions {
  roomId: string;
  name?: string;
  meeting?: Record<string, unknown> | null;
  powerLevels?: Record<string, unknown>;
  eventType?: string;
}

function fakeRoom({
  roomId,
  name = roomId,
  meeting = {},
  powerLevels,
  eventType = DEFAULT_TYPE,
}: RoomOptions): Room {
  return {
    roomId,
    name,
    currentState: {
      getStateEvents: (type: string) => {
        if (type === eventType && meeting !== null)
          return { getContent: () => meeting };
        if (type === "m.room.power_levels" && powerLevels !== undefined)
          return { getContent: () => powerLevels };
        return null;
      },
    },
  } as unknown as Room;
}

function fakeClient(rooms: Room[]): {
  client: MatrixClient;
  emitter: EventEmitter;
  off: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const off = vi.fn((event: string, handler: () => void) => {
    emitter.off(event, handler);
  });
  const client = {
    getRooms: () => rooms,
    getUserId: () => ME,
    getAccessToken: () => "syt_token",
    on: (event: string, handler: () => void) => emitter.on(event, handler),
    off,
  } as unknown as MatrixClient;
  return { client, emitter, off };
}

function inMinutes(minutes: number): number {
  return Date.now() + minutes * 60000;
}

afterEach(() => vi.restoreAllMocks());

describe("useScheduledMeetings", () => {
  it("reports loading until the first scan has run", () => {
    mockConfig({});
    const { client } = fakeClient([]);
    const seen: boolean[] = [];
    const { result } = renderHook(() => {
      const value = useScheduledMeetings(client);
      seen.push(value.loading);
      return value;
    });
    // An empty list on its own cannot say whether anything has been read yet.
    expect(seen[0]).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.meetings).toEqual([]);
  });

  it("surfaces the join link", () => {
    mockConfig({});
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!a:example.org",
        meeting: {
          scheduled_start: inMinutes(30),
          meet_link: "https://call.example.org/meet-x#?password=abc",
        },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings[0].meetLink).toBe(
      "https://call.example.org/meet-x#?password=abc",
    );
  });

  it("leaves the join link empty when the meeting has none", () => {
    mockConfig({});
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!a:example.org",
        meeting: { scheduled_start: inMinutes(30) },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings[0].meetLink).toBe("");
  });

  it("skips rooms with no meeting on them", () => {
    mockConfig({});
    const { client } = fakeClient([
      fakeRoom({ roomId: "!a:example.org", meeting: null }),
      fakeRoom({ roomId: "!b:example.org", meeting: {} }),
      fakeRoom({
        roomId: "!c:example.org",
        meeting: { scheduled_start: inMinutes(30) },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings.map((m) => m.room.roomId)).toEqual([
      "!c:example.org",
    ]);
  });

  it("keeps a meeting that started inside the grace window", () => {
    mockConfig({});
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!a:example.org",
        meeting: { scheduled_start: inMinutes(-59) },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings).toHaveLength(1);
  });

  it("drops a meeting that started before the grace window", () => {
    mockConfig({});
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!a:example.org",
        meeting: { scheduled_start: inMinutes(-61) },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings).toEqual([]);
  });

  it("sorts by start time", () => {
    mockConfig({});
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!late:example.org",
        meeting: { scheduled_start: inMinutes(120) },
      }),
      fakeRoom({
        roomId: "!soon:example.org",
        meeting: { scheduled_start: inMinutes(10) },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings.map((m) => m.room.roomId)).toEqual([
      "!soon:example.org",
      "!late:example.org",
    ]);
  });

  it("honours a configured event type", () => {
    mockConfig({ branding: { meeting_event_type: "io.example.booking" } });
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!a:example.org",
        eventType: "io.example.booking",
        meeting: { scheduled_start: inMinutes(30) },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings).toHaveLength(1);
  });

  it("falls back to the configured time zone", () => {
    mockConfig({ calendar: { default_timezone: "Pacific/Auckland" } });
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!a:example.org",
        meeting: { scheduled_start: inMinutes(30) },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings[0].timezone).toBe("Pacific/Auckland");
  });

  it("treats a user above the join-rule level as an admin", () => {
    mockConfig({});
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!a:example.org",
        meeting: { scheduled_start: inMinutes(30) },
        powerLevels: {
          users: { [ME]: 100 },
          events: { "m.room.join_rules": 50 },
        },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings[0].isAdmin).toBe(true);
  });

  it("treats a user below the join-rule level as an ordinary member", () => {
    mockConfig({});
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!a:example.org",
        meeting: { scheduled_start: inMinutes(30) },
        powerLevels: {
          users: { [ME]: 0 },
          events: { "m.room.join_rules": 50 },
        },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings[0].isAdmin).toBe(false);
  });

  it("falls back to comparing against the default power level", () => {
    mockConfig({});
    const { client } = fakeClient([
      fakeRoom({
        roomId: "!a:example.org",
        meeting: { scheduled_start: inMinutes(30) },
        powerLevels: { users: { [ME]: 50 }, users_default: 0 },
      }),
    ]);
    const { result } = renderHook(() => useScheduledMeetings(client));
    expect(result.current.meetings[0].isAdmin).toBe(true);
  });

  it("rescans when room state changes", () => {
    mockConfig({});
    const rooms = [
      fakeRoom({
        roomId: "!a:example.org",
        meeting: { scheduled_start: inMinutes(30) },
      }),
    ];
    const { client, emitter } = fakeClient(rooms);
    const { result } = renderHook(() => useScheduledMeetings(client));
    const before = result.current.meetings;

    rooms.push(
      fakeRoom({
        roomId: "!b:example.org",
        meeting: { scheduled_start: inMinutes(60) },
      }),
    );
    act(() => {
      emitter.emit(RoomEvent.CurrentStateUpdated);
    });

    expect(result.current.meetings).not.toBe(before);
    expect(result.current.meetings).toHaveLength(2);
  });

  it("stops listening to both events when unmounted", () => {
    mockConfig({});
    const { client, off } = fakeClient([]);
    const { unmount } = renderHook(() => useScheduledMeetings(client));
    unmount();
    expect(off).toHaveBeenCalledWith(
      RoomEvent.MyMembership,
      expect.any(Function),
    );
    expect(off).toHaveBeenCalledWith(
      RoomEvent.CurrentStateUpdated,
      expect.any(Function),
    );
  });
});

describe("rescheduleMeeting", () => {
  it("sends exactly the three fields the service accepts", async () => {
    mockConfig({ admin_api_url: ADMIN_API });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { client } = fakeClient([]);

    await rescheduleMeeting(client, "!a:example.org", {
      scheduled_start: 1,
      scheduled_end: 2,
      timezone: "UTC",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ADMIN_API}/api/admin/rooms/!a%3Aexample.org`);
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer syt_token",
    );
    expect(Object.keys(JSON.parse(init?.body as string))).toEqual([
      "scheduled_start",
      "scheduled_end",
      "timezone",
    ]);
  });

  it("fails when the service rejects the change", async () => {
    mockConfig({ admin_api_url: ADMIN_API });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 403 }),
    );
    const { client } = fakeClient([]);
    await expect(
      rescheduleMeeting(client, "!a:example.org", {
        scheduled_start: 1,
        scheduled_end: 2,
        timezone: "UTC",
      }),
    ).rejects.toThrow();
  });

  it("fails when there is no scheduling service", async () => {
    mockConfig({});
    const { client } = fakeClient([]);
    await expect(
      rescheduleMeeting(client, "!a:example.org", {
        scheduled_start: 1,
        scheduled_end: 2,
        timezone: "UTC",
      }),
    ).rejects.toThrow();
  });
});

describe("cancelMeeting", () => {
  it("asks the service to withdraw the meeting", async () => {
    mockConfig({ admin_api_url: ADMIN_API });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { client } = fakeClient([]);

    await cancelMeeting(client, { roomId: "!a:example.org" } as Room);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ADMIN_API}/api/admin/rooms/!a%3Aexample.org`);
    expect(init?.method).toBe("DELETE");
  });

  it("empties and leaves the room where there is no service", async () => {
    mockConfig({});
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const kick = vi.fn().mockResolvedValue(undefined);
    const leave = vi.fn().mockResolvedValue(undefined);
    const client = {
      getUserId: () => ME,
      kick,
      leave,
    } as unknown as MatrixClient;

    await cancelMeeting(client, {
      roomId: "!a:example.org",
      getJoinedMembers: () => [{ userId: ME }, { userId: "@them:example.org" }],
    } as unknown as Room);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(kick).toHaveBeenCalledWith("!a:example.org", "@them:example.org");
    expect(kick).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith("!a:example.org");
  });
});
