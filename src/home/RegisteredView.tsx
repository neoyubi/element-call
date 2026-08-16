/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  useState,
  useCallback,
  type FormEvent,
  type FormEventHandler,
  type ChangeEvent,
  type FC,
} from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { useTranslation } from "react-i18next";
import { Heading, Text } from "@vector-im/compound-web";
import { logger } from "matrix-js-sdk/lib/logger";
import { Button } from "@vector-im/compound-web";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { CalendarIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import { Separator } from "@vector-im/compound-web";
import AddIcon from "@vector-im/compound-design-tokens/assets/web/icons/plus";
import ChevronDownIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-down";

import {
  createRoom,
  getRelativeRoomUrl,
  sanitiseRoomNameInput,
} from "../utils/matrix";
import { useGroupCallRooms } from "./useGroupCallRooms";
import { Header, HeaderLogo, LeftNav, RightNav } from "../Header";
import commonStyles from "./common.module.css";
import styles from "./RegisteredView.module.css";
import guestStyles from "./UnauthenticatedView.module.css";
import { FieldRow, InputField, ErrorMessage } from "../input/Input";
import { CallList } from "./CallList";
import { UpcomingMeetings } from "./UpcomingMeetings";
import { NextUp } from "./NextUp";
import { ScheduleMeetingForm } from "./ScheduleMeetingForm";
import { useCanSchedule } from "./useCanSchedule";
import { useScheduledMeetings } from "./useScheduledMeetings";
import { Modal } from "../Modal";
import { UserMenuContainer } from "../UserMenuContainer";
import { JoinExistingCallModal } from "./JoinExistingCallModal";
import { Form } from "../form/Form";
import { AnalyticsNotice } from "../analytics/AnalyticsNotice";
import { E2eeType } from "../e2ee/e2eeType";
import {
  useOptInAnalytics,
  useSetting,
  homeRecentOpen,
} from "../settings/settings";
import { useUrlParams } from "../UrlParams";
import { CodeInput } from "./CodeInput";
import { parseRotatingCode, deriveSharedKey } from "../e2ee/deriveKeyFromCode";
import { saveKeyMaterialForAlias } from "../e2ee/sharedKeyManagement";
import { Config } from "../config/Config";
import { productName } from "../branding";
import { widget } from "../widget";

interface Props {
  client: MatrixClient;
  isPasswordlessUser: boolean;
}

export const RegisteredView: FC<Props> = ({ client, isPasswordlessUser }) => {
  const { header } = useUrlParams();
  const { meetings, loading: meetingsLoading } = useScheduledMeetings(client);
  const [scheduling, setScheduling] = useState(false);
  const [recentOpen, setRecentOpen] = useSetting(homeRecentOpen);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error>();
  const [optInAnalytics] = useOptInAnalytics();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [joinExistingCallModalOpen, setJoinExistingCallModalOpen] =
    useState(false);
  const onDismissJoinExistingCallModal = useCallback(
    () => setJoinExistingCallModalOpen(false),
    [setJoinExistingCallModalOpen],
  );

  const onSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const data = new FormData(e.target as HTMLFormElement);
      const roomNameData = data.get("callName");
      const roomName =
        typeof roomNameData === "string"
          ? sanitiseRoomNameInput(roomNameData)
          : "";

      async function submit(): Promise<void> {
        setError(undefined);
        setLoading(true);

        const createRoomResult = await createRoom(
          client,
          roomName,
          E2eeType.SHARED_KEY,
        );
        if (!createRoomResult.password)
          throw new Error("Failed to create room with shared secret");

        await navigate(
          getRelativeRoomUrl(
            createRoomResult.roomId,
            { kind: E2eeType.SHARED_KEY, secret: createRoomResult.password },
            createRoomResult.roomCode,
          ),
        );
      }

      submit().catch((error) => {
        if (error.errcode === "M_ROOM_IN_USE") {
          setExistingAlias(roomName);
          setLoading(false);
          setError(undefined);
          setJoinExistingCallModalOpen(true);
        } else {
          logger.error(error);
          setLoading(false);
          setError(error);
        }
      });
    },
    [client, navigate, setJoinExistingCallModalOpen],
  );

  // Guest join form state
  const [activeTab, setActiveTab] = useState<"code" | "link">("code");
  const [codeValue, setCodeValue] = useState("");
  const [linkValue, setLinkValue] = useState("");
  const [joinError, setJoinError] = useState<Error>();
  const [joinDeriving, setJoinDeriving] = useState(false);

  const onCodeChange = useCallback((value: string) => {
    setCodeValue(value);
    setJoinError(undefined);
  }, []);

  const onLinkChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setLinkValue(e.target.value);
    setJoinError(undefined);
  }, []);

  const onJoinSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (e) => {
      e.preventDefault();
      if (activeTab === "code") {
        const parsed = parseRotatingCode(codeValue);
        if (!parsed) {
          setJoinError(new Error("Please enter a valid meeting code"));
          return;
        }

        if (parsed.keyMaterial) {
          const { roomCode, keyMaterial } = parsed;
          const alias = `#${roomCode}:${Config.defaultServerName()}`;

          setJoinDeriving(true);
          void deriveSharedKey(keyMaterial, alias)
            .then((derivedKey) => {
              saveKeyMaterialForAlias(alias, keyMaterial);
              void navigate(
                `/${roomCode}#?password=${encodeURIComponent(derivedKey)}`,
              );
            })
            .catch((err: unknown) => {
              logger.error("Failed to derive key from code", err);
              setJoinError(new Error("Failed to process meeting code"));
            })
            .finally(() => setJoinDeriving(false));
        } else {
          navigate(`/${parsed.roomCode}`)?.catch(() => {});
        }
      } else {
        if (!linkValue.trim()) {
          setJoinError(new Error("Please paste a meeting link"));
          return;
        }
        try {
          const url = new URL(linkValue);
          const path = url.pathname + url.hash;
          navigate(path)?.catch(() => {});
        } catch {
          navigate(linkValue)?.catch(() => {});
        }
      }
    },
    [activeTab, codeValue, linkValue, navigate],
  );

  const joinCodeValid = codeValue.length === 4 || codeValue.length === 8;

  const recentRooms = useGroupCallRooms(client);
  const canSchedule = useCanSchedule(client);

  const [existingAlias, setExistingAlias] = useState<string>();
  const onJoinExistingRoom = useCallback(() => {
    navigate(`/${existingAlias}`)?.catch((error) => {
      logger.error("Failed to navigate to existing alias", error);
    });
  }, [navigate, existingAlias]);

  return (
    <>
      <div className={commonStyles.container}>
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
        <main className={commonStyles.main}>
          <div className={styles.column}>
            <HeaderLogo className={commonStyles.logo} />
            {isPasswordlessUser ? (
              <>
                <Heading size="lg" weight="semibold">
                  {t("landing.heading", {
                    brand: productName(),
                  })}
                </Heading>
                <div className={guestStyles.tabs}>
                  <button
                    type="button"
                    className={`${guestStyles.tab} ${activeTab === "code" ? guestStyles.activeTab : ""}`}
                    onClick={() => setActiveTab("code")}
                  >
                    {t("landing.tab_code")}
                  </button>
                  <button
                    type="button"
                    className={`${guestStyles.tab} ${activeTab === "link" ? guestStyles.activeTab : ""}`}
                    onClick={() => setActiveTab("link")}
                  >
                    {t("landing.tab_link")}
                  </button>
                </div>
                <Form className={guestStyles.form} onSubmit={onJoinSubmit}>
                  {activeTab === "code" ? (
                    <CodeInput
                      value={codeValue}
                      onChange={onCodeChange}
                      disabled={joinDeriving}
                    />
                  ) : (
                    <FieldRow>
                      <InputField
                        id="meetingLink"
                        name="meetingLink"
                        label={t("landing.join_link_placeholder")}
                        placeholder={t("landing.join_link_placeholder")}
                        type="url"
                        autoComplete="off"
                        value={linkValue}
                        onChange={onLinkChange}
                        data-testid="home_meetingLink"
                      />
                    </FieldRow>
                  )}
                  {joinError && (
                    <FieldRow>
                      <ErrorMessage error={joinError} />
                    </FieldRow>
                  )}
                  <Button
                    type="submit"
                    size="lg"
                    disabled={
                      joinDeriving ||
                      (activeTab === "code"
                        ? !joinCodeValid
                        : !linkValue.trim())
                    }
                    data-testid="home_join"
                  >
                    {joinDeriving
                      ? t("common.loading")
                      : t("landing.join_button")}
                  </Button>
                </Form>
              </>
            ) : (
              <>
                {canSchedule && (
                  <>
                    <NextUp meetings={meetings} loading={meetingsLoading} />
                    <Button
                      size="lg"
                      Icon={AddIcon}
                      className={styles.scheduleCta}
                      onClick={() => setScheduling(true)}
                    >
                      {t("home.schedule_cta")}
                    </Button>
                    <div className={styles.separator}>
                      <Separator />
                      <Text size="sm" className={styles.separatorLabel}>
                        {t("home.or_instant_call")}
                      </Text>
                      <Separator />
                    </div>
                  </>
                )}
                {!canSchedule && (
                  <Heading size="lg" weight="semibold">
                    {t("start_new_call")}
                  </Heading>
                )}
                <Form className={styles.form} onSubmit={onSubmit}>
                  <FieldRow className={styles.fieldRow}>
                    <InputField
                      id="callName"
                      name="callName"
                      label={t("call_name")}
                      placeholder={t("call_name")}
                      type="text"
                      required
                      autoComplete="off"
                      data-testid="home_callName"
                    />
                    <Button
                      type="submit"
                      size="lg"
                      className={styles.button}
                      disabled={loading}
                      data-testid="home_go"
                    >
                      {loading ? t("common.loading") : t("action.go")}
                    </Button>
                  </FieldRow>
                  {optInAnalytics === null && (
                    <Text size="sm" className={styles.notice}>
                      <AnalyticsNotice />
                    </Text>
                  )}
                  {error && (
                    <FieldRow className={styles.fieldRow}>
                      <ErrorMessage error={error} />
                    </FieldRow>
                  )}
                </Form>
              </>
            )}

            <UpcomingMeetings
              client={client}
              meetings={meetings}
              featured={meetings.find((m) => Date.now() < m.scheduledEnd)}
            />

            {recentRooms.length > 0 && (
              <section className={styles.section}>
                <button
                  type="button"
                  className={styles.sectionTrigger}
                  aria-expanded={recentOpen}
                  aria-controls="home-recent"
                  onClick={() => setRecentOpen(!recentOpen)}
                >
                  <ChevronDownIcon
                    width={16}
                    height={16}
                    className={
                      recentOpen ? styles.triggerIconOpen : styles.triggerIcon
                    }
                  />
                  <Text as="h2" size="sm" weight="semibold">
                    {t("home.recent_calls", { count: recentRooms.length })}
                  </Text>
                </button>
                {recentOpen && (
                  <div id="home-recent">
                    <CallList rooms={recentRooms} client={client} />
                  </div>
                )}
              </section>
            )}

            {/* A widget has no way to route anywhere but the call it was
              opened for, so the calendar is a standalone affordance. */}
            {!widget && (
              <RouterLink to="/calendar" className={styles.calendarLink}>
                <CalendarIcon width={20} height={20} aria-hidden />
                {t("calendar.open")}
              </RouterLink>
            )}
          </div>
        </main>
      </div>

      <Modal
        title={t("schedule_meeting.title")}
        hideHeader
        open={scheduling}
        onDismiss={() => setScheduling(false)}
      >
        <ScheduleMeetingForm
          client={client}
          onDone={() => setScheduling(false)}
        />
      </Modal>

      <JoinExistingCallModal
        onJoin={onJoinExistingRoom}
        open={joinExistingCallModalOpen}
        onDismiss={onDismissJoinExistingCallModal}
      />
    </>
  );
};
