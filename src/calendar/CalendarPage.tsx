import { type FC, useCallback, useMemo, useState } from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { type TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Navigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Heading,
  IconButton,
  InlineSpinner,
  NavBar,
  NavItem,
  Text,
} from "@vector-im/compound-web";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useClientState } from "../ClientContext";
import { ErrorPage, LoadingPage } from "../FullScreenView";
import { Header, HeaderLogo, LeftNav, RightNav } from "../Header";
import { Modal } from "../Modal";
import { UserMenuContainer } from "../UserMenuContainer";
import { useUrlParams } from "../UrlParams";
import { usePageTitle } from "../usePageTitle";
import { useBehavior } from "../useBehavior";
import { useMediaQuery } from "../useMediaQuery";
import { widget } from "../widget";
import {
  useScheduledMeetings,
  type ScheduledMeeting,
} from "../home/useScheduledMeetings";
import { formatDate, formatTime } from "../home/dateFormat";
import { ScheduleMeetingForm } from "../home/ScheduleMeetingForm";
import { useCanSchedule } from "../home/useCanSchedule";
import { useSetting, calendarView } from "../settings/settings";
import { AgendaView } from "./AgendaView";
import { EventDetails } from "./EventDetails";
import { MonthView } from "./MonthView";
import { NARROW_VIEWPORT, WeekView } from "./WeekView";
import { now$ } from "./now";
import {
  CALENDAR_VIEWS,
  type CalendarView,
  addDays,
  firstDayOfWeek,
  formatDateRange,
  formatDay,
  formatMonth,
  fromDateParam,
  isCalendarView,
  startOfDay,
  stepDate,
  toDateParam,
  viewRange,
  weekDays,
  workingHours,
} from "./dates";
import styles from "./CalendarPage.module.css";

export const CalendarPage: FC = () => {
  const { t } = useTranslation();
  usePageTitle(t("calendar.title"));
  const clientState = useClientState();

  if (!clientState) return <LoadingPage />;
  if (clientState.state === "error")
    return <ErrorPage widget={widget} error={clientState.error} />;
  if (!clientState.authenticated) return <Navigate to="/" replace />;
  return <Calendar client={clientState.authenticated.client} />;
};

function viewLabel(view: CalendarView, t: TFunction<"app">): string {
  switch (view) {
    case "day":
      return t("calendar.view_day");
    case "week":
      return t("calendar.view_week");
    case "month":
      return t("calendar.view_month");
    case "agenda":
      return t("calendar.view_agenda");
  }
}

const Calendar: FC<{ client: MatrixClient }> = ({ client }) => {
  const { t, i18n } = useTranslation();
  const { header } = useUrlParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { meetings, loading } = useScheduledMeetings(client);
  const canSchedule = useCanSchedule(client);
  const now = useBehavior(now$);
  const narrow = useMediaQuery(NARROW_VIEWPORT);
  const [preferredView, setPreferredView] = useSetting(calendarView);
  const [selected, setSelected] = useState<ScheduledMeeting | null>(null);
  const [slot, setSlot] = useState<Date | null>(null);

  // The URL owns the view and the focused date, so the back button works and
  // a link restores exactly what the sender was looking at.
  const viewParam = searchParams.get("view");
  const view = isCalendarView(viewParam)
    ? viewParam
    : (preferredView ?? (narrow ? "agenda" : "week"));
  const dateParam = searchParams.get("date");
  const focusedDate = useMemo(
    () => fromDateParam(dateParam) ?? startOfDay(new Date(now)),
    [dateParam, now],
  );

  const firstDay = firstDayOfWeek(i18n.language);
  const range = useMemo(
    () => viewRange(view, focusedDate, firstDay),
    [view, focusedDate, firstDay],
  );

  const navigate = useCallback(
    (next: { view?: CalendarView; date?: Date }, replace = false): void => {
      setSearchParams(
        (params) => {
          const updated = new URLSearchParams(params);
          if (next.view !== undefined) updated.set("view", next.view);
          if (next.date !== undefined)
            updated.set("date", toDateParam(next.date));
          return updated;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  const onChangeView = useCallback(
    (next: CalendarView): void => {
      setPreferredView(next);
      navigate({ view: next });
    },
    [navigate, setPreferredView],
  );

  const onStep = useCallback(
    (direction: 1 | -1): void =>
      navigate({ date: stepDate(view, focusedDate, direction) }),
    [navigate, view, focusedDate],
  );

  const onSelectDay = useCallback(
    (date: Date): void => {
      setPreferredView("day");
      navigate({ view: "day", date });
    },
    [navigate, setPreferredView],
  );

  const label =
    view === "week"
      ? formatDateRange(i18n.language, range.start, addDays(range.end, -1))
      : view === "day"
        ? formatDay(i18n.language, focusedDate)
        : formatMonth(i18n.language, focusedDate);

  return (
    <div className={styles.page}>
      {header === "standard" && (
        <Header>
          <LeftNav>
            <HeaderLogo />
          </LeftNav>
          <RightNav>
            <UserMenuContainer />
          </RightNav>
        </Header>
      )}
      <main className={styles.main}>
        <div className={styles.toolbar}>
          <div className={styles.navigation}>
            <IconButton
              size="var(--cpd-space-11x)"
              aria-label={t("calendar.previous")}
              onClick={() => onStep(-1)}
            >
              <ChevronLeftIcon />
            </IconButton>
            <IconButton
              size="var(--cpd-space-11x)"
              aria-label={t("calendar.next")}
              onClick={() => onStep(1)}
            >
              <ChevronRightIcon />
            </IconButton>
            <Button
              kind="secondary"
              size="sm"
              onClick={() => navigate({ date: startOfDay(new Date(now)) })}
            >
              {t("calendar.today")}
            </Button>
            <Heading as="h1" size="sm" weight="semibold">
              {label}
            </Heading>
          </div>
          {canSchedule && (
            <Button
              size="sm"
              Icon={PlusIcon}
              onClick={() =>
                setSlot(
                  new Date(
                    focusedDate.getFullYear(),
                    focusedDate.getMonth(),
                    focusedDate.getDate(),
                    workingHours().start,
                  ),
                )
              }
            >
              {t("schedule_meeting.title")}
            </Button>
          )}
          <NavBar aria-label={t("calendar.title")}>
            {CALENDAR_VIEWS.map((candidate) => (
              <NavItem
                key={candidate}
                active={candidate === view}
                onClick={() => onChangeView(candidate)}
              >
                {viewLabel(candidate, t)}
              </NavItem>
            ))}
          </NavBar>
        </div>

        {loading ? (
          <div className={styles.status}>
            <InlineSpinner />
            <Text size="md">{t("calendar.loading")}</Text>
          </div>
        ) : (
          <div className={styles.body}>
            {view === "month" && (
              <MonthView
                focusedDate={focusedDate}
                meetings={meetings}
                onSelectDay={onSelectDay}
                onSelectMeeting={setSelected}
                onFocusDate={(date) => navigate({ date }, true)}
              />
            )}
            {(view === "week" || view === "day") && (
              <WeekView
                days={
                  view === "day"
                    ? [focusedDate]
                    : weekDays(focusedDate, firstDay)
                }
                focusedDate={focusedDate}
                meetings={meetings}
                canSchedule={canSchedule}
                onSelectDay={onSelectDay}
                onSelectMeeting={setSelected}
                onSelectSlot={setSlot}
              />
            )}
            {view === "agenda" && (
              <AgendaView
                meetings={meetings}
                rangeStart={range.start}
                rangeEnd={range.end}
                onSelectMeeting={setSelected}
              />
            )}
          </div>
        )}
      </main>

      <Modal
        title={t("calendar.meeting_details")}
        open={selected !== null}
        onDismiss={() => setSelected(null)}
      >
        {selected !== null && (
          <EventDetails
            meeting={selected}
            client={client}
            canModify={canSchedule}
            onDone={() => setSelected(null)}
          />
        )}
      </Modal>

      <Modal
        title={t("schedule_meeting.title")}
        hideHeader
        open={slot !== null}
        onDismiss={() => setSlot(null)}
      >
        {slot !== null && (
          <ScheduleMeetingForm
            key={slot.getTime()}
            client={client}
            initialDate={formatDate(slot.getTime())}
            initialTime={formatTime(slot.getTime())}
          />
        )}
      </Modal>
    </div>
  );
};
