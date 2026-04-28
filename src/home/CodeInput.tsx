import {
  type FC,
  useCallback,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";

import styles from "./UnauthenticatedView.module.css";
import { ROOM_CODE_CHARS } from "../e2ee/deriveKeyFromCode";

const GROUP_COUNT = 2;
const GROUP_SIZE = 4;
const TOTAL_CHARS = GROUP_COUNT * GROUP_SIZE;

interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export const CodeInput: FC<CodeInputProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const groupRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Split the value into groups of 4
  const groups: string[] = [];
  for (let i = 0; i < GROUP_COUNT; i++) {
    groups.push(value.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE));
  }

  const rebuildValue = useCallback(
    (groupIndex: number, groupValue: string): void => {
      const newGroups = [...groups];
      newGroups[groupIndex] = groupValue;
      onChange(newGroups.join(""));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, onChange],
  );

  const onGroupChange = useCallback(
    (index: number) =>
      (e: ChangeEvent<HTMLInputElement>): void => {
        const raw = e.target.value
          .toUpperCase()
          .split("")
          .filter((c) => ROOM_CODE_CHARS.includes(c))
          .join("")
          .slice(0, GROUP_SIZE);
        e.target.value = raw;
        rebuildValue(index, raw);

        // Auto-advance to next group when full
        if (raw.length === GROUP_SIZE && index < GROUP_COUNT - 1) {
          groupRefs.current[index + 1]?.focus();
        }
      },
    [rebuildValue],
  );

  const onGroupKeyDown = useCallback(
    (index: number) =>
      (e: KeyboardEvent<HTMLInputElement>): void => {
        if (e.key === "Backspace") {
          const target = e.currentTarget;
          if (
            target.selectionStart === 0 &&
            target.selectionEnd === 0 &&
            index > 0
          ) {
            e.preventDefault();
            const prev = groupRefs.current[index - 1];
            if (prev) {
              prev.focus();
              prev.setSelectionRange(prev.value.length, prev.value.length);
            }
          }
        } else if (
          e.key === "ArrowLeft" &&
          e.currentTarget.selectionStart === 0 &&
          index > 0
        ) {
          const prev = groupRefs.current[index - 1];
          if (prev) {
            prev.focus();
            prev.setSelectionRange(prev.value.length, prev.value.length);
          }
        } else if (
          e.key === "ArrowRight" &&
          e.currentTarget.selectionStart === e.currentTarget.value.length &&
          index < GROUP_COUNT - 1
        ) {
          const next = groupRefs.current[index + 1];
          if (next) {
            next.focus();
            next.setSelectionRange(0, 0);
          }
        }
      },
    [],
  );

  const onGroupPaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>): void => {
      e.preventDefault();
      const pasted = e.clipboardData
        .getData("text")
        .toUpperCase()
        .replace(/-/g, "")
        .split("")
        .filter((c) => ROOM_CODE_CHARS.includes(c))
        .join("")
        .slice(0, TOTAL_CHARS);

      onChange(pasted);

      // Distribute across visible inputs
      for (let i = 0; i < GROUP_COUNT; i++) {
        const ref = groupRefs.current[i];
        if (ref) ref.value = pasted.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE);
      }

      // Focus appropriate group
      const fullGroups = Math.floor(pasted.length / GROUP_SIZE);
      const focusIndex = Math.min(fullGroups, GROUP_COUNT - 1);
      groupRefs.current[focusIndex]?.focus();
    },
    [onChange],
  );

  return (
    <div className={styles.codeBoxes} data-testid="home_roomCode">
      {groups.map((group, i) => (
        <span key={i} className={styles.codeGroup}>
          <input
            ref={(el) => {
              groupRefs.current[i] = el;
            }}
            className={styles.codeBox}
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={GROUP_SIZE + 1}
            defaultValue={group}
            onChange={onGroupChange(i)}
            onKeyDown={onGroupKeyDown(i)}
            onPaste={onGroupPaste}
            onFocus={(e) => e.target.select()}
            disabled={disabled}
            aria-label={`Code group ${i + 1}`}
          />
          {i < GROUP_COUNT - 1 && (
            <span className={styles.codeDash} aria-hidden>
              -
            </span>
          )}
        </span>
      ))}
    </div>
  );
};
