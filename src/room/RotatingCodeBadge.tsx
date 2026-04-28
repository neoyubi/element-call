import {
  type FC,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import classNames from "classnames";
import {
  VisibilityOnIcon,
  VisibilityOffIcon,
  RestartIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import copy from "copy-to-clipboard";

import { type RotatingCodeState } from "../e2ee/useRotatingCode";
import { ROTATION_INTERVAL_MS } from "../e2ee/deriveKeyFromCode";
import styles from "./RotatingCodeBadge.module.css";

interface Props {
  codeState: RotatingCodeState;
  onCopied?: () => void;
  /** When false, the code stays blurred with no reveal/copy/regenerate ability. */
  canReveal?: boolean;
  /** Generate new master key material. Only shown when revealed and canReveal. */
  onRegenerate?: () => void;
}

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const ROTATION_SECONDS = ROTATION_INTERVAL_MS / 1000;

export const RotatingCodeBadge: FC<Props> = ({
  codeState,
  onCopied,
  canReveal = true,
  onRegenerate,
}) => {
  const { t } = useTranslation();
  const { code, secondsLeft } = codeState;
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const prevCodeRef = useRef(code);

  // Trigger rotation animation when code changes
  useEffect(() => {
    if (code && prevCodeRef.current && code !== prevCodeRef.current) {
      setRotating(true);
      const timeout = setTimeout(() => setRotating(false), 400);
      return (): void => {
        clearTimeout(timeout);
      };
    }
    prevCodeRef.current = code;
  }, [code]);

  const onCodeClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (!canReveal) return;
      if (!revealed) {
        setRevealed(true);
        return;
      }
      if (code) {
        copy(code);
        onCopied?.();
      }
    },
    [canReveal, revealed, code, onCopied],
  );

  const onToggleVisibility = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (!canReveal) return;
      setRevealed((r) => !r);
    },
    [canReveal],
  );

  const onRegenerateClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onRegenerate?.();
    },
    [onRegenerate],
  );

  if (!code) return null;

  const progress = secondsLeft / ROTATION_SECONDS;
  const dashOffset = RING_CIRCUMFERENCE * (1 - progress);

  return (
    <div className={classNames(styles.badge, { [styles.disabled]: !canReveal })}>
      <button
        className={styles.codeButton}
        onClick={onCodeClick}
        title={
          !canReveal
            ? t("room_code.label")
            : revealed
              ? t("room_code.label")
              : t("room_code.tap_to_reveal")
        }
        type="button"
        disabled={!canReveal}
      >
        <span
          className={classNames(styles.code, {
            [styles.blurred]: !revealed,
            [styles.rotating]: rotating && revealed,
          })}
          aria-hidden={!revealed}
        >
          {code}
        </span>
        {!revealed && canReveal && (
          <span className={styles.revealHint}>{t("room_code.reveal")}</span>
        )}
      </button>
      {revealed && (
        <>
          <span className={styles.countdown}>
            <svg
              className={styles.countdownRing}
              viewBox="0 0 22 22"
              aria-hidden="true"
            >
              <circle
                className={styles.countdownRingTrack}
                cx="11"
                cy="11"
                r={RING_RADIUS}
              />
              <circle
                className={styles.countdownRingProgress}
                cx="11"
                cy="11"
                r={RING_RADIUS}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={dashOffset}
              />
            </svg>
            <span className={styles.countdownText}>{secondsLeft}</span>
          </span>
          {onRegenerate && (
            <button
              className={styles.actionButton}
              onClick={onRegenerateClick}
              type="button"
              aria-label={t("room_code.regenerate")}
              title={t("room_code.regenerate")}
            >
              <RestartIcon aria-hidden="true" />
            </button>
          )}
          <button
            className={styles.actionButton}
            onClick={onToggleVisibility}
            type="button"
            aria-label={t("room_code.hide")}
          >
            <VisibilityOffIcon aria-hidden="true" />
          </button>
        </>
      )}
      {!revealed && canReveal && (
        <button
          className={styles.actionButton}
          onClick={onToggleVisibility}
          type="button"
          aria-label={t("room_code.reveal")}
        >
          <VisibilityOnIcon aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
