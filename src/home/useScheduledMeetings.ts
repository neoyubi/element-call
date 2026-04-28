import { type MatrixClient, type Room, RoomEvent } from "matrix-js-sdk";
import { useState, useEffect } from "react";

import { Config } from "../config/Config";

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
}

const DEFAULT_MEETING_STATE_TYPE = "io.element.call.scheduled_meeting";
// Show meetings up to 1 hour after their start (in-progress grace)
const GRACE_MS = 3600000;

export function useScheduledMeetings(
  client: MatrixClient,
): ScheduledMeeting[] {
  const [meetings, setMeetings] = useState<ScheduledMeeting[]>([]);

  useEffect(() => {
    const meetingStateType =
      Config.get().branding?.meeting_event_type ?? DEFAULT_MEETING_STATE_TYPE;

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
          scheduledEnd: (content.scheduled_end as number) || scheduledStart + 3600000,
          organizerName: (content.organizer_name as string) || "",
          prospectName: (content.prospect_name as string) || "",
          practiceType: (content.practice_type as string) || "solo",
          timezone: (content.timezone as string) || "Europe/Amsterdam",
          isAdmin,
        });
      }

      // Sort by scheduledStart ascending (soonest first)
      results.sort((a, b) => a.scheduledStart - b.scheduledStart);
      setMeetings(results);
    }

    updateMeetings();

    client.on(RoomEvent.MyMembership, updateMeetings);
    client.on(RoomEvent.CurrentStateUpdated, updateMeetings);
    return (): void => {
      client.off(RoomEvent.MyMembership, updateMeetings);
      client.off(RoomEvent.CurrentStateUpdated, updateMeetings);
    };
  }, [client]);

  return meetings;
}
