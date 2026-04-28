import { type FC, useState, useCallback } from "react";
import { Text } from "@vector-im/compound-web";

import { Modal } from "./Modal";
import { LicenseSettingsTab } from "./settings/LicenseSettingsTab";
import { Config } from "./config/Config";
import styles from "./LicenseFooter.module.css";

const DEFAULT_SOURCE_CODE_URL = "https://github.com/element-hq/element-call";

export const LicenseFooter: FC = () => {
  const [open, setOpen] = useState(false);
  const onOpen = useCallback(() => setOpen(true), []);
  const onDismiss = useCallback(() => setOpen(false), []);

  const branding = Config.get().branding;
  const sourceCodeUrl = branding?.source_code_url ?? DEFAULT_SOURCE_CODE_URL;

  return (
    <>
      <div className={styles.footer}>
        {branding?.footer_text && branding?.footer_url ? (
          <Text size="sm" as="span">
            Based on OSS, refined by{" "}
            <a
              href={branding.footer_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {branding.footer_text}
            </a>
          </Text>
        ) : (
          <Text size="sm" as="span">
            Licensed under AGPL-3.0
          </Text>
        )}
        <Text size="sm" as="span" className={styles.separator}>
          <a
            href={sourceCodeUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Source
          </a>
        </Text>
        <Text size="sm" as="span" className={styles.separator}>
          <button type="button" onClick={onOpen}>
            License
          </button>
        </Text>
      </div>
      <Modal
        title="License"
        open={open}
        onDismiss={onDismiss}
        className={styles.licenseModal}
      >
        <LicenseSettingsTab />
      </Modal>
    </>
  );
};
