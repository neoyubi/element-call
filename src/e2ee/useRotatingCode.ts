import { useEffect, useState } from "react";

import {
  formatRotatingCode,
  getTimeSlot,
  ROTATION_INTERVAL_MS,
} from "./deriveKeyFromCode";

export interface RotatingCodeState {
  /** Current display code, or null if inputs missing. */
  code: string | null;
  /** Seconds until the current code expires. */
  secondsLeft: number;
}

function secondsUntilNextSlot(): number {
  const msLeft = ROTATION_INTERVAL_MS - (Date.now() % ROTATION_INTERVAL_MS);
  return Math.ceil(msLeft / 1000);
}

/**
 * Returns the current rotating display code with a 1-second countdown.
 * Code and countdown update live every second.
 */
export function useRotatingCode(
  roomCode: string | null,
  masterMaterial: string | null,
): RotatingCodeState {
  const [secondsLeft, setSecondsLeft] = useState(secondsUntilNextSlot);
  const [currentSlot, setCurrentSlot] = useState(getTimeSlot);

  useEffect(() => {
    if (!roomCode || !masterMaterial) return;

    const interval = setInterval(() => {
      const now = Date.now();
      setCurrentSlot(getTimeSlot(now));
      const msLeft = ROTATION_INTERVAL_MS - (now % ROTATION_INTERVAL_MS);
      setSecondsLeft(Math.ceil(msLeft / 1000));
    }, 1000);

    return (): void => {
      clearInterval(interval);
    };
  }, [roomCode, masterMaterial]);

  if (!roomCode || !masterMaterial) {
    return { code: null, secondsLeft: 0 };
  }

  const code = formatRotatingCode(roomCode, masterMaterial, currentSlot);
  return { code, secondsLeft };
}
