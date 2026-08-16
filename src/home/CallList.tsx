/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { Link } from "react-router-dom";
import {
  type RoomMember,
  type Room,
  type MatrixClient,
  EventType,
} from "matrix-js-sdk";
import {
  type FC,
  useCallback,
  useEffect,
  type MouseEvent,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { IconButton, Text } from "@vector-im/compound-web";
import {
  CloseIcon,
  DeleteIcon,
  LockSolidIcon,
  LockOffIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";
import { logger } from "matrix-js-sdk/lib/logger";

import { Avatar, Size } from "../Avatar";
import styles from "./CallList.module.css";
import { getRelativeRoomUrl } from "../utils/matrix";
import { type GroupCallRoom } from "./useGroupCallRooms";
import { useRoomEncryptionSystem } from "../e2ee/sharedKeyManagement";

interface CallListProps {
  rooms: GroupCallRoom[];
  client: MatrixClient;
}

export const CallList: FC<CallListProps> = ({ rooms, client }) => {
  return (
    <>
      <div className={styles.callList}>
        {rooms.map(
          ({ room, roomName, avatarUrl, participants, closed, isAdmin }) => (
            <CallTile
              key={room.roomId}
              client={client}
              name={roomName}
              avatarUrl={avatarUrl}
              room={room}
              participants={participants}
              closed={closed}
              isAdmin={isAdmin}
            />
          ),
        )}
        {rooms.length > 3 && (
          <>
            <div className={styles.callTileSpacer} />
            <div className={styles.callTileSpacer} />
          </>
        )}
      </div>
    </>
  );
};
interface CallTileProps {
  name: string;
  avatarUrl: string;
  room: Room;
  participants: RoomMember[];
  client: MatrixClient;
  closed: boolean;
  isAdmin: boolean;
}

const CallTile: FC<CallTileProps> = ({
  name,
  avatarUrl,
  room,
  client,
  closed,
  isAdmin,
}) => {
  const { t } = useTranslation();
  const roomEncryptionSystem = useRoomEncryptionSystem(room.roomId);
  const [isLeaving, setIsLeaving] = useState(false);
  const [isDeleted, setIsDeleted] = useState(false);
  const isJoined = room.getMyMembership() === "join";

  // Optimistic closed state: override until the real state catches up
  const [closedOverride, setClosedOverride] = useState<boolean | null>(null);
  const effectiveClosed = closedOverride ?? closed;

  // Reset override when the real prop catches up
  useEffect(() => {
    setClosedOverride(null);
  }, [closed]);

  const onRemove = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setIsLeaving(true);
      client.leave(room.roomId).catch(() => setIsLeaving(false));
    },
    [room, client],
  );

  const onToggleClosed = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const newClosed = !effectiveClosed;
      setClosedOverride(newClosed);
      const newRule = newClosed ? "invite" : "knock";
      void client
        .sendStateEvent(
          room.roomId,
          EventType.RoomJoinRules,
          { join_rule: newRule },
          "",
        )
        .then(() => {
          logger.info(`Room ${room.roomId} join rule changed to ${newRule}`);
        })
        .catch((err: unknown) => {
          logger.error("Failed to toggle room closed state", err);
          setClosedOverride(null);
        });
    },
    [room, client, effectiveClosed],
  );

  const onDeleteRoom = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setIsDeleted(true);
      setIsLeaving(true);
      // Kick all other members, then leave
      const members = room.getJoinedMembers();
      const myUserId = client.getUserId()!;
      const kickAll = members
        .filter((m) => m.userId !== myUserId)
        .map((m) =>
          client.kick(room.roomId, m.userId).catch((err: unknown) => {
            logger.error(`Failed to kick ${m.userId}`, err);
          }),
        );
      void Promise.all(kickAll)
        .then(async () => {
          await client.leave(room.roomId);
          logger.info(`Room ${room.roomId} deleted`);
        })
        .catch((err: unknown) => {
          logger.error("Failed to delete room", err);
          setIsDeleted(false);
          setIsLeaving(false);
        });
    },
    [room, client],
  );

  if (isDeleted) return null;

  const body = (
    <>
      <Avatar id={room.roomId} name={name} size={Size.LG} src={avatarUrl} />
      <div className={styles.callInfo}>
        <Text weight="semibold" className={styles.callName}>
          {name}
        </Text>
      </div>
      {isAdmin ? (
        <div className={styles.adminActions}>
          <IconButton
            size="var(--cpd-space-11x)"
            onClick={onToggleClosed}
            disabled={isLeaving || !isJoined}
            aria-label={
              effectiveClosed ? t("room_status.reopen") : t("room_status.close")
            }
          >
            {effectiveClosed ? <LockSolidIcon /> : <LockOffIcon />}
          </IconButton>
          <IconButton
            size="var(--cpd-space-11x)"
            onClick={onDeleteRoom}
            disabled={isLeaving}
            aria-label={t("room_status.delete")}
          >
            <DeleteIcon />
          </IconButton>
        </div>
      ) : (
        <IconButton
          size="var(--cpd-space-11x)"
          onClick={onRemove}
          disabled={isLeaving}
          aria-label={t("action.remove")}
        >
          <CloseIcon />
        </IconButton>
      )}
    </>
  );

  return (
    <div className={styles.callTile}>
      {isLeaving ? (
        <span className={classNames(styles.callTileLink, styles.disabled)}>
          {body}
        </span>
      ) : (
        <Link
          to={getRelativeRoomUrl(room.roomId, roomEncryptionSystem, room.name)}
          className={styles.callTileLink}
        >
          {body}
        </Link>
      )}
    </div>
  );
};
