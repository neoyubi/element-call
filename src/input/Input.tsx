/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type ChangeEvent,
  type FocusEvent,
  type FC,
  type ForwardedRef,
  type ReactNode,
  useId,
  type JSX,
  type Ref,
} from "react";
import classNames from "classnames";

import styles from "./Input.module.css";
import CheckIcon from "../icons/Check.svg?react";
import { TranslatedError } from "../TranslatedError";

interface FieldRowProps {
  children: ReactNode;
  rightAlign?: boolean;
  className?: string;
}

export function FieldRow({
  children,
  rightAlign,
  className,
}: FieldRowProps): JSX.Element {
  return (
    <div
      className={classNames(
        styles.fieldRow,
        { [styles.rightAlign]: rightAlign },
        className,
      )}
    >
      {children}
    </div>
  );
}

interface FieldProps {
  children: ReactNode;
  className?: string;
}

function Field({ children, className }: FieldProps): JSX.Element {
  return <div className={classNames(styles.field, className)}>{children}</div>;
}

interface InputFieldProps {
  ref?: Ref<HTMLInputElement | HTMLTextAreaElement>;
  label?: string;
  type: string;
  prefix?: string;
  suffix?: string;
  id?: string;
  checked?: boolean;
  className?: string;
  description?: string | ReactNode;
  /**
   * Marks the control invalid and shows the message beneath it. Takes
   * precedence over any `aria-invalid` passed in.
   */
  error?: string;
  disabled?: boolean;
  required?: boolean;
  // this is a hack. Those variables should be part of `HTMLAttributes<HTMLInputElement> | HTMLAttributes<HTMLTextAreaElement>`
  // but extending from this union type does not work
  name?: string;
  autoComplete?: string;
  autoCorrect?: string;
  autoCapitalize?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  defaultChecked?: boolean;
  min?: number;
  onBlur?: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  /** Marks the control invalid to assistive technology. */
  "aria-invalid"?: boolean;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}

export const InputField: FC<InputFieldProps> = ({
  ref,
  id,
  label,
  className,
  type,
  checked,
  prefix,
  suffix,
  description,
  error,
  disabled,
  min,
  "aria-invalid": ariaInvalid,
  ...rest
}) => {
  const descriptionId = useId();
  const errorId = `${descriptionId}-error`;
  const checkbox = type === "checkbox";
  const invalid = error !== undefined;

  const describedBy =
    [description ? descriptionId : undefined, invalid ? errorId : undefined]
      .filter((value) => value !== undefined)
      .join(" ") || undefined;

  const shared = {
    id,
    disabled,
    "aria-describedby": describedBy,
    "aria-invalid": invalid ? true : ariaInvalid,
  };

  const control = (
    <Field
      className={classNames(
        checkbox ? styles.checkboxField : styles.inputField,
        {
          [styles.prefix]: !!prefix,
          [styles.disabled]: disabled,
          [styles.invalid]: !checkbox && invalid,
        },
        className,
      )}
    >
      {prefix && <span>{prefix}</span>}
      {type === "textarea" ? (
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        <textarea
          ref={ref as ForwardedRef<HTMLTextAreaElement>}
          {...shared}
          {...rest}
        />
      ) : (
        <input
          ref={ref as ForwardedRef<HTMLInputElement>}
          type={type}
          checked={checked}
          min={min}
          {...shared}
          {...rest}
        />
      )}

      <label htmlFor={id}>
        {checkbox && (
          <div className={styles.checkbox}>
            <CheckIcon />
          </div>
        )}
        {label}
      </label>
      {suffix && <span>{suffix}</span>}
      {/* A checkbox field wraps, so its description can share the box. */}
      {checkbox && description && (
        <p
          id={descriptionId}
          className={
            label
              ? styles.description
              : classNames(styles.description, styles.noLabel)
          }
        >
          {description}
        </p>
      )}
    </Field>
  );

  if (checkbox) return control;

  // The text field's box is a flex row holding the control and its floating
  // label, so anything else placed inside it is laid out beside the input and
  // ends up underneath the label. Supporting text belongs below the box.
  //
  // The wrapper is unconditional: introducing it only once there is something
  // to say would replace the field's DOM node the moment an error appeared or
  // cleared, taking the caret and the focus with it.
  return (
    <div className={styles.fieldGroup}>
      {control}
      {description && (
        <p id={descriptionId} className={styles.fieldDescription}>
          {description}
        </p>
      )}
      {invalid && (
        <p id={errorId} className={styles.fieldError}>
          {error}
        </p>
      )}
    </div>
  );
};

InputField.displayName = "InputField";

interface ErrorMessageProps {
  error: Error;
}

export const ErrorMessage: FC<ErrorMessageProps> = ({ error }) => (
  <p className={styles.errorMessage}>
    {error instanceof TranslatedError ? error.translatedMessage : error.message}
  </p>
);
