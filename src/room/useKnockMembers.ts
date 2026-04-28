import { useCallback, useRef } from "react";
import { type RoomMember, type Room, KnownMembership } from "matrix-js-sdk";

import { useRoomState } from "./useRoomState";

/**
 * Returns the list of members currently knocking on the room.
 */
export function useKnockMembers(room: Room): RoomMember[] {
  const prevRef = useRef<RoomMember[]>([]);

  return useRoomState(
    room,
    useCallback(
      (state) => {
        const members = state
          .getMembers()
          .filter((m) => m.membership === KnownMembership.Knock);
        // Cache the result to maintain referential stability for useSyncExternalStore.
        // .filter() always returns a new array, which causes an infinite re-render loop
        // since useSyncExternalStore compares snapshots with Object.is().
        if (
          members.length === prevRef.current.length &&
          members.every((m, i) => m === prevRef.current[i])
        ) {
          return prevRef.current;
        }
        prevRef.current = members;
        return members;
      },
      [],
    ),
  );
}
