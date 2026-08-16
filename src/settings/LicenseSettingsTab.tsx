import { type FC } from "react";
import { Text } from "@vector-im/compound-web";

import { Config } from "../config/Config";

const DEFAULT_SOURCE_CODE_URL = "https://github.com/neoyubi/neo-call";

export const LicenseSettingsTab: FC = () => {
  const sourceCodeUrl =
    Config.get().branding?.source_code_url ?? DEFAULT_SOURCE_CODE_URL;

  return (
    <div>
      <h4>Open Source License</h4>
      <Text>
        This application is based on{" "}
        <a
          href="https://github.com/element-hq/element-call"
          target="_blank"
          rel="noopener noreferrer"
        >
          Element Call
        </a>
        , licensed under the{" "}
        <a
          href="https://www.gnu.org/licenses/agpl-3.0.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          GNU Affero General Public License v3.0
        </a>
        .
      </Text>
      <Text>
        The complete source code for this deployment, including any
        modifications, is available at:{" "}
        <a href={sourceCodeUrl} target="_blank" rel="noopener noreferrer">
          {sourceCodeUrl.replace(/^https?:\/\//, "")}
        </a>
      </Text>
    </div>
  );
};
