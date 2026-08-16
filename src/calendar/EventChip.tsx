import {
  type CSSProperties,
  type FC,
  type MouseEvent,
  useCallback,
} from "react";
import { useTranslation } from "react-i18next";
import classNames from "classnames";

import { type ScheduledMeeting } from "../home/useScheduledMeetings";
import { formatTimeOfDay } from "./dates";
import styles from "./EventChip.module.css";

interface Props {
  meeting: ScheduledMeeting;
  /** Sized to its duration in a time grid, rather than one dense line. */
  block?: boolean;
  inProgress?: boolean;
  onSelect: (meeting: ScheduledMeeting) => void;
  className?: string;
  style?: CSSProperties;
  tabIndex?: number;
}

/** One meeting, as it appears inside a calendar grid. */
export const EventChip: FC<Props> = ({
  meeting,
  block,
  inProgress,
  onSelect,
  className,
  style,
  tabIndex,
}) => {
  const { i18n } = useTranslation();

  const onClick = useCallback(
    (e: MouseEvent): void => {
      // The day cell underneath answers clicks too.
      e.stopPropagation();
      onSelect(meeting);
    },
    [meeting, onSelect],
  );

  return (
    <button
      type="button"
      className={classNames(styles.chip, className, {
        [styles.block]: block,
        [styles.inProgress]: inProgress,
      })}
      style={style}
      tabIndex={tabIndex}
      onClick={onClick}
    >
      <span className={styles.time}>
        {formatTimeOfDay(i18n.language, meeting.scheduledStart)}
      </span>
      <span className={styles.name}>{meeting.roomName}</span>
    </button>
  );
};
