import { map, timer } from "rxjs";

import { globalScope } from "../state/ObservableScope";

const MINUTE_MS = 60000;

/**
 * The wall clock, re-read once a minute.
 *
 * Anything that renders a relative time ("in 20 minutes") or marks today has
 * to read this rather than calling Date.now() while rendering, otherwise a tab
 * left open keeps showing the time it was opened at. The first tick is aligned
 * to the top of the minute so the display changes when the clock does, rather
 * than a minute after the page happened to load.
 */
export const now$ = globalScope.behavior(
  timer(MINUTE_MS - (Date.now() % MINUTE_MS), MINUTE_MS).pipe(
    map(() => Date.now()),
  ),
  Date.now(),
);
