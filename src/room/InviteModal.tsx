/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type FC,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { type Room } from "matrix-js-sdk";
import { Button, Text } from "@vector-im/compound-web";
import {
  LinkIcon,
  CheckIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";
import copy from "copy-to-clipboard";

import { Modal } from "../Modal";
import { getAbsoluteRoomUrl } from "../utils/matrix";
import styles from "./InviteModal.module.css";
import { Toast } from "../Toast";
import {
  useRoomEncryptionSystem,
  getKeyMaterialForAlias,
} from "../e2ee/sharedKeyManagement";
import { QrCode } from "../QrCode";
import { useRotatingCode } from "../e2ee/useRotatingCode";
import { ROTATION_INTERVAL_MS } from "../e2ee/deriveKeyFromCode";

const RING_RADIUS = 14;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const ROTATION_SECONDS = ROTATION_INTERVAL_MS / 1000;

interface Props {
  room: Room;
  open: boolean;
  onDismiss: () => void;
}

export const InviteModal: FC<Props> = ({ room, open, onDismiss }) => {
  const { t } = useTranslation();
  const e2eeSystem = useRoomEncryptionSystem(room.roomId);

  const canonicalAlias = room.getCanonicalAlias();
  const roomCode = canonicalAlias?.split(":")[0]?.replace("#", "") ?? undefined;
  const url = useMemo(
    () => getAbsoluteRoomUrl(room.roomId, e2eeSystem, roomCode ?? room.name),
    [e2eeSystem, room.name, room.roomId, roomCode],
  );

  // Rotating code with live countdown
  const storedKeyMaterial = useMemo(
    () => (canonicalAlias ? getKeyMaterialForAlias(canonicalAlias) : null),
    [canonicalAlias],
  );
  const { code: extendedCode, secondsLeft } = useRotatingCode(
    roomCode ?? null,
    storedKeyMaterial,
  );

  // Code rotation animation
  const [rotating, setRotating] = useState(false);
  const prevCodeRef = useRef(extendedCode);
  useEffect(() => {
    if (
      extendedCode &&
      prevCodeRef.current &&
      extendedCode !== prevCodeRef.current
    ) {
      setRotating(true);
      const timeout = setTimeout(() => setRotating(false), 400);
      return (): void => {
        clearTimeout(timeout);
      };
    }
    prevCodeRef.current = extendedCode;
  }, [extendedCode]);

  const [linkToastOpen, setLinkToastOpen] = useState(false);
  const onLinkToastDismiss = useCallback(
    () => setLinkToastOpen(false),
    [setLinkToastOpen],
  );
  const [codeToastOpen, setCodeToastOpen] = useState(false);
  const onCodeToastDismiss = useCallback(
    () => setCodeToastOpen(false),
    [setCodeToastOpen],
  );

  const onCopyLink = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      copy(url);
      onDismiss();
      setLinkToastOpen(true);
    },
    [url, onDismiss],
  );

  const onCopyCode = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (extendedCode) {
        copy(extendedCode);
        onDismiss();
        setCodeToastOpen(true);
      }
    },
    [extendedCode, onDismiss],
  );

  const progress = secondsLeft / ROTATION_SECONDS;
  const dashOffset = RING_CIRCUMFERENCE * (1 - progress);

  return (
    <>
      <Modal title={t("invite_modal.title")} open={open} onDismiss={onDismiss}>
        <QrCode className={styles.qrCode} data={url} />
        <Text className={styles.url} size="sm" weight="semibold">
          {url}
        </Text>
        <Button
          className={styles.button}
          Icon={LinkIcon}
          onClick={onCopyLink}
          data-testid="modal_inviteLink"
        >
          {t("action.copy_link")}
        </Button>
        {extendedCode && (
          <>
            <div className={styles.divider} />
            <Text className={styles.codeLabel} size="sm" weight="semibold">
              {t("invite_modal.meeting_code")}
            </Text>
            <div className={styles.codeRow}>
              <Text
                className={classNames(styles.extendedCode, {
                  [styles.rotating]: rotating,
                })}
                size="lg"
                weight="bold"
              >
                {extendedCode}
              </Text>
              <span className={styles.countdown}>
                <svg
                  className={styles.countdownRing}
                  viewBox="0 0 32 32"
                  aria-hidden="true"
                >
                  <circle
                    className={styles.countdownRingTrack}
                    cx="16"
                    cy="16"
                    r={RING_RADIUS}
                  />
                  <circle
                    className={styles.countdownRingProgress}
                    cx="16"
                    cy="16"
                    r={RING_RADIUS}
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={dashOffset}
                  />
                </svg>
                <span className={styles.countdownText}>{secondsLeft}</span>
              </span>
            </div>
            <Button
              className={styles.button}
              kind="secondary"
              onClick={onCopyCode}
              data-testid="modal_inviteCode"
            >
              {t("invite_modal.copy_code")}
            </Button>
          </>
        )}
      </Modal>
      <Toast
        open={linkToastOpen}
        onDismiss={onLinkToastDismiss}
        autoDismiss={2000}
        Icon={CheckIcon}
      >
        {t("invite_modal.link_copied_toast")}
      </Toast>
      <Toast
        open={codeToastOpen}
        onDismiss={onCodeToastDismiss}
        autoDismiss={2000}
        Icon={CheckIcon}
      >
        {t("invite_modal.code_copied_toast")}
      </Toast>
    </>
  );
};
