import { type MatrixClient, type Room, RoomEvent } from "matrix-js-sdk";
import { useState, useEffect } from "react";
import { logger } from "matrix-js-sdk/lib/logger";

import { Config } from "../config/Config";
import { CALENDAR_DEFAULTS } from "../config/ConfigOptions";

/**
 * Scheduled meetings, and the two writes that change one.
 *
 * Reading is a scan of the rooms already synced, so it works offline and
 * updates the moment a change arrives. Writing always goes through the admin
 * API: it is what bumps the calendar sequence, rewrites the calendar entry and
 * sends the mail. Writing the room state from here would skip all three.
 */

export interface ScheduledMeeting {
  room: Room;
  roomName: string;
  bookingId: string;
  scheduledStart: number;
  scheduledEnd: number;
  organizerName: string;
  prospectName: string;
  practiceType: string;
  timezone: string;
  isAdmin: boolean;
  /** Absolute join URL, or "" when the meeting has none. */
  meetLink: string;
}

export interface ScheduledMeetings {
  meetings: ScheduledMeeting[];
  /**
   * True until the first scan has run. An empty list on its own cannot tell
   * "still syncing" apart from "nothing scheduled".
   */
  loading: boolean;
}

const DEFAULT_MEETING_STATE_TYPE = "io.element.call.scheduled_meeting";
// Show meetings up to 1 hour after their start (in-progress grace)
const GRACE_MS = 3600000;
// Duration assumed when the state event carries no end (malformed state)
const DEFAULT_DURATION_MS = 3600000;

export function useScheduledMeetings(client: MatrixClient): ScheduledMeetings {
  const [meetings, setMeetings] = useState<ScheduledMeeting[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const meetingStateType =
      Config.get().branding?.meeting_event_type ?? DEFAULT_MEETING_STATE_TYPE;
    const defaultTimezone =
      Config.get().calendar?.default_timezone ??
      CALENDAR_DEFAULTS.default_timezone;

    function updateMeetings(): void {
      const now = Date.now();
      const myUserId = client.getUserId()!;
      const results: ScheduledMeeting[] = [];

      for (const room of client.getRooms()) {
        const meetingEvent = room.currentState.getStateEvents(
          meetingStateType,
          "",
        );
        if (!meetingEvent || Array.isArray(meetingEvent)) continue;

        const content = meetingEvent.getContent();
        if (!content.scheduled_start) continue;

        const scheduledStart = content.scheduled_start as number;
        // Filter: only future meetings or ones within the grace period
        if (scheduledStart < now - GRACE_MS) continue;

        // Power level check (same pattern as useGroupCallRooms)
        const powerLevels = room.currentState.getStateEvents(
          "m.room.power_levels",
          "",
        );
        let isAdmin = false;
        if (powerLevels && !Array.isArray(powerLevels)) {
          const plContent = powerLevels.getContent();
          const userLevel =
            plContent.users?.[myUserId] ?? plContent.users_default ?? 0;
          const joinRulesLevel = plContent.events?.["m.room.join_rules"];
          if (joinRulesLevel !== undefined) {
            isAdmin = userLevel >= joinRulesLevel;
          } else {
            const usersDefault = plContent.users_default ?? 0;
            isAdmin =
              plContent.users?.[myUserId] !== undefined &&
              userLevel > usersDefault;
          }
        }

        results.push({
          room,
          roomName: room.name,
          bookingId: (content.booking_id as string) || "",
          scheduledStart,
          scheduledEnd:
            (content.scheduled_end as number) ||
            scheduledStart + DEFAULT_DURATION_MS,
          organizerName: (content.organizer_name as string) || "",
          prospectName: (content.prospect_name as string) || "",
          practiceType: (content.practice_type as string) || "solo",
          timezone: (content.timezone as string) || defaultTimezone,
          isAdmin,
          meetLink: (content.meet_link as string) || "",
        });
      }

      // Sort by scheduledStart ascending (soonest first)
      results.sort((a, b) => a.scheduledStart - b.scheduledStart);
      setMeetings(results);
      setLoading(false);
    }

    updateMeetings();

    client.on(RoomEvent.MyMembership, updateMeetings);
    client.on(RoomEvent.CurrentStateUpdated, updateMeetings);
    return (): void => {
      client.off(RoomEvent.MyMembership, updateMeetings);
      client.off(RoomEvent.CurrentStateUpdated, updateMeetings);
    };
  }, [client]);

  return { meetings, loading };
}

/** The whole body of a reschedule. Nothing else may be sent. */
export interface RescheduleBody {
  scheduled_start: number;
  scheduled_end: number;
  timezone: string;
}

function adminApiUrl(): string | undefined {
  return Config.get().admin_api_url;
}

function authorization(client: MatrixClient): Record<string, string> {
  const token = client.getAccessToken();
  if (!token) throw new Error("Missing access token");
  return { Authorization: `Bearer ${token}` };
}

/** Moves a meeting. The updated state arrives back through sync. */
export async function rescheduleMeeting(
  client: MatrixClient,
  roomId: string,
  body: RescheduleBody,
): Promise<void> {
  const url = adminApiUrl();
  if (!url) throw new Error("Scheduling is not configured");

  const response = await fetch(
    `${url}/api/admin/rooms/${encodeURIComponent(roomId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...authorization(client),
      },
      body: JSON.stringify(body),
    },
  );
  if (response.status !== 200)
    throw new Error(`Update failed (${response.status})`);
}

/**
 * Cancels a meeting, which also withdraws the calendar entry and tears the
 * room down. Where no admin API is configured there is nobody to do either,
 * so the room is emptied and left instead.
 */
export async function cancelMeeting(
  client: MatrixClient,
  room: Room,
): Promise<void> {
  const url = adminApiUrl();
  if (url) {
    const response = await fetch(
      `${url}/api/admin/rooms/${encodeURIComponent(room.roomId)}`,
      { method: "DELETE", headers: authorization(client) },
    );
    if (!response.ok)
      throw new Error(`Cancellation failed (${response.status})`);
    return;
  }

  const myUserId = client.getUserId()!;
  await Promise.all(
    room
      .getJoinedMembers()
      .filter((member) => member.userId !== myUserId)
      .map(async (member) => {
        try {
          await client.kick(room.roomId, member.userId);
        } catch (err) {
          logger.error(`Failed to remove ${member.userId}`, err);
        }
      }),
  );
  await client.leave(room.roomId);
}
