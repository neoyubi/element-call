import { type FC, useCallback, useState } from "react";
import {
  type MatrixClient,
  type RoomMember,
  EventType,
} from "matrix-js-sdk";
import { useTranslation } from "react-i18next";
import { Button, Text } from "@vector-im/compound-web";
import { logger } from "matrix-js-sdk/lib/logger";

import { Modal } from "../Modal";
import { Avatar, Size as AvatarSize } from "../Avatar";
import styles from "./KnockRequestsPanel.module.css";

interface Props {
  client: MatrixClient;
  roomId: string;
  knockMembers: RoomMember[];
  open: boolean;
  onDismiss: () => void;
}

export const KnockRequestsPanel: FC<Props> = ({
  client,
  roomId,
  knockMembers,
  open,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const [closing, setClosing] = useState(false);

  const onApprove = useCallback(
    (userId: string) => {
      client.invite(roomId, userId).catch((e) => {
        logger.error("Failed to approve knock request", e);
      });
    },
    [client, roomId],
  );

  const onReject = useCallback(
    (userId: string) => {
      client.kick(roomId, userId).catch((e) => {
        logger.error("Failed to reject knock request", e);
      });
    },
    [client, roomId],
  );

  const onCloseRoom = useCallback(() => {
    setClosing(true);
    // Reject all pending knocks, then change join rule to invite-only
    const rejectAll = knockMembers.map((m) =>
      client.kick(roomId, m.userId).catch((e) => {
        logger.error("Failed to reject knock during room close", e);
      }),
    );
    Promise.all(rejectAll)
      .then(async () => {
        await client.sendStateEvent(roomId, EventType.RoomJoinRules, {
          join_rule: "invite",
        }, "");
        logger.info("Room closed to new join requests");
        onDismiss();
      })
      .catch((e) => {
        logger.error("Failed to close room", e);
      })
      .finally(() => setClosing(false));
  }, [client, roomId, knockMembers, onDismiss]);

  return (
    <Modal
      title={t("knock_requests.title")}
      open={open}
      onDismiss={onDismiss}
    >
      <div className={styles.list}>
        {knockMembers.length === 0 ? (
          <Text size="sm" className={styles.empty}>
            {t("knock_requests.empty")}
          </Text>
        ) : (
          knockMembers.map((member) => (
            <KnockRequestRow
              key={member.userId}
              member={member}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))
        )}
      </div>
      <div className={styles.footer}>
        <Button
          size="sm"
          kind="destructive"
          onClick={onCloseRoom}
          disabled={closing}
        >
          {closing
            ? t("common.loading")
            : t("knock_requests.close_room")}
        </Button>
        <Text size="xs" className={styles.closeHint}>
          {t("knock_requests.close_room_hint")}
        </Text>
      </div>
    </Modal>
  );
};

interface RowProps {
  member: RoomMember;
  onApprove: (userId: string) => void;
  onReject: (userId: string) => void;
}

const KnockRequestRow: FC<RowProps> = ({ member, onApprove, onReject }) => {
  const { t } = useTranslation();
  const approve = useCallback(
    () => onApprove(member.userId),
    [onApprove, member.userId],
  );
  const reject = useCallback(
    () => onReject(member.userId),
    [onReject, member.userId],
  );

  return (
    <div className={styles.row}>
      <Avatar
        id={member.userId}
        name={member.name}
        src={member.getMxcAvatarUrl() ?? undefined}
        size={AvatarSize.SM}
      />
      <Text size="sm" weight="semibold" className={styles.name}>
        {member.name}
      </Text>
      <div className={styles.actions}>
        <Button size="sm" kind="secondary" onClick={reject}>
          {t("knock_requests.reject")}
        </Button>
        <Button size="sm" onClick={approve}>
          {t("knock_requests.approve")}
        </Button>
      </div>
    </div>
  );
};
