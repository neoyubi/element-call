import { type MatrixClient, KnownMembership, RoomEvent } from "matrix-js-sdk";
import { useState, useEffect } from "react";

import { Config } from "../config/Config";

/**
 * Whether the current user is allowed to schedule meetings. True iff the user
 * is a joined member of the room configured as `schedulers_room_id`. Returns
 * false when the config option is unset or the user is not joined. The result
 * updates reactively as the user's membership changes.
 */
export function useCanSchedule(client: MatrixClient): boolean {
  const [canSchedule, setCanSchedule] = useState(false);

  useEffect(() => {
    const schedulersRoomId = Config.get().schedulers_room_id;

    function update(): void {
      if (!schedulersRoomId) {
        setCanSchedule(false);
        return;
      }
      const room = client.getRoom(schedulersRoomId);
      setCanSchedule(room?.getMyMembership() === KnownMembership.Join);
    }

    update();

    // Membership transitions (join/leave/invite) for the current user fire
    // MyMembership, which is exactly what gates scheduling access.
    client.on(RoomEvent.MyMembership, update);
    return (): void => {
      client.off(RoomEvent.MyMembership, update);
    };
  }, [client]);

  return canSchedule;
}
