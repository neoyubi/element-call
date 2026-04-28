/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type FC,
  useCallback,
  useState,
  type FormEventHandler,
  type ChangeEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Button, Heading, Text } from "@vector-im/compound-web";
import { useNavigate } from "react-router-dom";
import { logger } from "matrix-js-sdk/lib/logger";

import { Header, HeaderLogo, LeftNav, RightNav } from "../Header";
import { FieldRow, InputField, ErrorMessage } from "../input/Input";
import { Form } from "../form/Form";
import styles from "./UnauthenticatedView.module.css";
import commonStyles from "./common.module.css";
import { Link } from "../button/Link";
import { useUrlParams } from "../UrlParams";
import { CodeInput } from "./CodeInput";
import { parseRotatingCode, deriveSharedKey } from "../e2ee/deriveKeyFromCode";
import { saveKeyMaterialForAlias } from "../e2ee/sharedKeyManagement";
import { Config } from "../config/Config";

export const UnauthenticatedView: FC = () => {
  const { header } = useUrlParams();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = useState<"code" | "link">("code");
  const [codeValue, setCodeValue] = useState("");
  const [linkValue, setLinkValue] = useState("");
  const [error, setError] = useState<Error>();
  const [deriving, setDeriving] = useState(false);

  const onCodeChange = useCallback((value: string) => {
    setCodeValue(value);
    setError(undefined);
  }, []);

  const onLinkChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setLinkValue(e.target.value);
    setError(undefined);
  }, []);

  const onSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (e) => {
      e.preventDefault();

      if (activeTab === "code") {
        const parsed = parseRotatingCode(codeValue);
        if (!parsed) {
          setError(new Error("Please enter a valid meeting code"));
          return;
        }

        if (parsed.keyMaterial) {
          const { roomCode, keyMaterial } = parsed;
          const alias = `#${roomCode}:${Config.defaultServerName()}`;

          setDeriving(true);
          void deriveSharedKey(keyMaterial, alias)
            .then((derivedKey) => {
              saveKeyMaterialForAlias(alias, keyMaterial);
              // Put derived key in URL fragment so existing E2EE machinery picks it up
              void navigate(
                `/${roomCode}#?password=${encodeURIComponent(derivedKey)}`,
              );
            })
            .catch((err: unknown) => {
              logger.error("Failed to derive key from code", err);
              setError(new Error("Failed to process meeting code"));
            })
            .finally(() => setDeriving(false));
        } else {
          navigate(`/${parsed.roomCode}`)?.catch(() => {});
        }
      } else {
        if (!linkValue.trim()) {
          setError(new Error("Please paste a meeting link"));
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

  const codeValid = codeValue.length === 4 || codeValue.length === 8;

  return (
    <div className={commonStyles.container}>
      {header === "standard" && (
        <Header>
          <LeftNav>
            <HeaderLogo />
          </LeftNav>
          <RightNav />
        </Header>
      )}
      <main className={commonStyles.main}>
        <HeaderLogo className={commonStyles.logo} />
        <Heading size="lg" weight="semibold">
          {t("landing.heading", {
            brand: import.meta.env.VITE_PRODUCT_NAME || "Element Call",
          })}
        </Heading>
        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${activeTab === "code" ? styles.activeTab : ""}`}
            onClick={() => setActiveTab("code")}
          >
            {t("landing.tab_code")}
          </button>
          <button
            type="button"
            className={`${styles.tab} ${activeTab === "link" ? styles.activeTab : ""}`}
            onClick={() => setActiveTab("link")}
          >
            {t("landing.tab_link")}
          </button>
        </div>
        <Form className={styles.form} onSubmit={onSubmit}>
          {activeTab === "code" ? (
            <CodeInput
              value={codeValue}
              onChange={onCodeChange}
              disabled={deriving}
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
          {error && (
            <FieldRow>
              <ErrorMessage error={error} />
            </FieldRow>
          )}
          <Button
            type="submit"
            size="lg"
            disabled={
              deriving ||
              (activeTab === "code" ? !codeValid : !linkValue.trim())
            }
            data-testid="home_join"
          >
            {deriving ? t("common.loading") : t("landing.join_button")}
          </Button>
        </Form>
      </main>
      <footer className={styles.footer}>
        <Text>
          <Link to="/login" data-testid="home_login">
            {t("landing.sign_in")}
          </Link>
        </Text>
      </footer>
    </div>
  );
};
