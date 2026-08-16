import {
  type ChangeEvent,
  type ClipboardEvent,
  type FC,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import classNames from "classnames";
import { useTranslation } from "react-i18next";

import { Config } from "../config/Config";
import { CALENDAR_DEFAULTS } from "../config/ConfigOptions";
import {
  appendDateInput,
  appendTimeInput,
  canonicalTimeToDigits,
  dateDigitCapacity,
  dateDigitsToIso,
  formatDateDigits,
  formatTimeDigits,
  isoToDateDigits,
  parsePastedDate,
  parsePastedTime,
  timeDigitCapacity,
  timeDigitsToCanonical,
} from "../home/dateFormat";
import styles from "./DateTimeInput.module.css";

// A digit stream rendered with separators. The caller exchanges the canonical
// value the rest of the app uses ("YYYY-MM-DD" or "HH:MM"); what the field
// shows is a written format the deployment configures.
export interface DateTimeInputProps {
  id?: string;
  /** Accessible name. The visible label belongs to the surrounding group. */
  label: string;
  /** Spoken hint describing the format, e.g. "Type the day, month and year…". */
  formatDescription: string;
  /** Visible placeholder that teaches the format, e.g. "dd.mm.yyyy". */
  placeholder: string;
  /** Canonical value, or "" while incomplete. */
  value: string;
  /** Longest stream the field accepts. */
  capacity: number;
  /** Seed the stream from a canonical value. */
  toDigits: (value: string) => string;
  /** Render a stream for display. */
  format: (digits: string) => string;
  /** Fold one or more typed characters into the stream. */
  append: (digits: string, input: string) => string;
  /** Read a pasted string as a stream. */
  parsePasted: (text: string) => string;
  /** Resolve a stream to its canonical value once it means something. */
  toCanonical: (digits: string) => string | undefined;
  /** Announced when blur completes a value the user did not finish typing. */
  describeNormalized: (value: string) => string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  disabled?: boolean;
}

export const DateTimeInput: FC<DateTimeInputProps> = ({
  id: providedId,
  label,
  formatDescription,
  placeholder,
  value,
  capacity,
  toDigits,
  format,
  append,
  parsePasted,
  toCanonical,
  describeNormalized,
  onChange,
  onBlur,
  error,
  disabled,
}) => {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = `${generatedId}-hint`;
  const errorId = `${generatedId}-error`;

  const inputRef = useRef<HTMLInputElement>(null);
  const [digits, setDigits] = useState(() => toDigits(value));
  const [announcement, setAnnouncement] = useState("");
  // Set when a change should leave the caret at the end rather than where the
  // digit count would put it, which is what typing at the end wants.
  const caretToEnd = useRef(false);

  // What this field last handed upwards. Comparing against it distinguishes a
  // value the parent replaced from the echo of our own change: mid-entry the
  // canonical form is briefly undefined, and re-seeding on that would wipe the
  // digits the user is still typing.
  const lastEmitted = useRef(value);

  // Follow the value when the parent replaces it, e.g. a slot prefill.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setDigits(toDigits(value));
  }, [value, toDigits]);

  useLayoutEffect(() => {
    if (!caretToEnd.current) return;
    caretToEnd.current = false;
    const input = inputRef.current;
    if (input === null) return;
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [digits]);

  const commit = useCallback(
    (next: string): void => {
      setDigits(next);
      const canonical = toCanonical(next) ?? "";
      lastEmitted.current = canonical;
      onChange(canonical);
    },
    [onChange, toCanonical],
  );

  const onInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const raw = event.target.value;
      const caret = event.target.selectionStart ?? raw.length;
      // Replaying the whole string keeps insertion, deletion and drag-drop on
      // one path, and lets the stream reject anything out of range.
      const next = append("", raw).slice(0, capacity);
      caretToEnd.current = caret >= raw.length;
      commit(next);
    },
    [append, capacity, commit],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      const input = event.currentTarget;
      const atEnd =
        input.selectionStart === input.selectionEnd &&
        input.selectionStart === input.value.length;

      // Backspace immediately after an inserted separator should take the digit
      // before it, not make the user press it twice for a character they never
      // typed.
      if (event.key === "Backspace" && atEnd) {
        event.preventDefault();
        caretToEnd.current = true;
        commit(digits.slice(0, -1));
        return;
      }

      // A typed separator needs no special case: the stream folds it in, where
      // it completes a segment holding a single digit and is ignored otherwise,
      // so it can never double up.
    },
    [commit, digits],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLInputElement>): void => {
      event.preventDefault();
      caretToEnd.current = true;
      commit(
        parsePasted(event.clipboardData.getData("text")).slice(0, capacity),
      );
    },
    [capacity, commit, parsePasted],
  );

  const onFieldBlur = useCallback((): void => {
    const canonical = toCanonical(digits);
    if (canonical !== undefined) {
      const completed = toDigits(canonical);
      // Only speak when blur finished something the user left half typed.
      if (completed !== digits) {
        setDigits(completed);
        setAnnouncement(describeNormalized(format(completed)));
      }
      lastEmitted.current = canonical;
      onChange(canonical);
    }
    onBlur?.();
  }, [
    describeNormalized,
    digits,
    format,
    onBlur,
    onChange,
    toCanonical,
    toDigits,
  ]);

  return (
    <div>
      <div
        className={classNames(styles.field, {
          [styles.invalid]: error !== undefined,
          [styles.disabled]: disabled,
        })}
      >
        <input
          id={id}
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          // Both ids: the format hint stays reachable while an error shows.
          aria-describedby={
            error === undefined ? hintId : `${hintId} ${errorId}`
          }
          aria-invalid={error !== undefined || undefined}
          placeholder={placeholder}
          value={format(digits)}
          disabled={disabled}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={onFieldBlur}
        />
      </div>
      <span id={hintId} className={styles.offscreen}>
        {formatDescription}
      </span>
      {error !== undefined && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
      <span role="status" aria-live="polite" className={styles.offscreen}>
        {announcement}
      </span>
    </div>
  );
};

interface FieldProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  disabled?: boolean;
}

/**
 * A date typed in the deployment's written order. Every caller gets the same
 * format, so the two scheduling surfaces cannot drift apart.
 */
export const DateField: FC<FieldProps> = (props) => {
  const { t } = useTranslation();
  const calendar = Config.get().calendar;
  const order =
    calendar?.date_input_order ?? CALENDAR_DEFAULTS.date_input_order;
  const separator =
    calendar?.date_input_separator ?? CALENDAR_DEFAULTS.date_input_separator;

  return (
    <DateTimeInput
      {...props}
      label={t("schedule_meeting.date")}
      formatDescription={t("schedule_meeting.date_format_description")}
      placeholder={t("schedule_meeting.date_format_hint")}
      capacity={dateDigitCapacity(order)}
      toDigits={useCallback(
        (value: string) => isoToDateDigits(value, order),
        [order],
      )}
      format={useCallback(
        (digits: string) => formatDateDigits(digits, order, separator),
        [order, separator],
      )}
      append={useCallback(
        (digits: string, input: string) =>
          appendDateInput(digits, input, order),
        [order],
      )}
      parsePasted={useCallback(
        (text: string) => parsePastedDate(text, order),
        [order],
      )}
      toCanonical={useCallback(
        (digits: string) => dateDigitsToIso(digits, order, new Date()),
        [order],
      )}
      describeNormalized={useCallback(
        (value: string) => t("schedule_meeting.date_normalized", { value }),
        [t],
      )}
    />
  );
};

/** A start time, typed on a 24-hour clock. */
export const TimeField: FC<FieldProps> = (props) => {
  const { t } = useTranslation();

  return (
    <DateTimeInput
      {...props}
      label={t("schedule_meeting.time")}
      formatDescription={t("schedule_meeting.time_format_description")}
      placeholder={t("schedule_meeting.time_format_hint")}
      capacity={timeDigitCapacity()}
      toDigits={canonicalTimeToDigits}
      format={formatTimeDigits}
      append={appendTimeInput}
      parsePasted={parsePastedTime}
      toCanonical={timeDigitsToCanonical}
      describeNormalized={useCallback(
        (value: string) => t("schedule_meeting.time_normalized", { value }),
        [t],
      )}
    />
  );
};
