/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useCallback } from "react";
import { secureRandomString } from "matrix-js-sdk/lib/randomstring";
import { logger } from "matrix-js-sdk/lib/logger";

import { useClient, type Session } from "../ClientContext";
import { useInteractiveRegistration } from "../auth/useInteractiveRegistration";
import { generateRandomName } from "../auth/generateRandomName";
import { useRecaptcha } from "../auth/useRecaptcha";
import { widget } from "../widget";
import { Config } from "../config/Config";
import { initClient } from "../utils/matrix";

interface UseRegisterPasswordlessUserType {
  privacyPolicyUrl?: string;
  registerPasswordlessUser: (displayName: string) => Promise<void>;
  recaptchaId?: string;
}

export function useRegisterPasswordlessUser(): UseRegisterPasswordlessUserType {
  const { setClient } = useClient();
  const proxyUrl = Config.get().guest_registration_url;

  // Hooks must be called unconditionally (React rules of hooks).
  // Pass enabled=false to skip the UIA probe request when using the proxy.
  const { privacyPolicyUrl, recaptchaKey, register } =
    useInteractiveRegistration(undefined, !proxyUrl);
  const { execute, reset, recaptchaId } = useRecaptcha(recaptchaKey);

  const registerPasswordlessUser = useCallback(
    async (displayName: string) => {
      if (!setClient) {
        throw new Error("No client context");
      }
      if (widget) {
        throw new Error(
          "Registration was skipped: We should never try to register password-less user in embedded mode.",
        );
      }

      if (proxyUrl) {
        // Server-side proxy path: shared secret never leaves the server
        const resp = await fetch(`${proxyUrl}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(
            (err as { error?: string }).error ||
              `Registration proxy returned ${resp.status}`,
          );
        }

        /* eslint-disable camelcase */
        const { user_id, access_token, device_id, password } =
          (await resp.json()) as {
            user_id: string;
            access_token: string;
            device_id: string;
            password: string;
          };

        const client = await initClient(
          {
            baseUrl: Config.defaultHomeserverUrl()!,
            accessToken: access_token,
            userId: user_id,
            deviceId: device_id,
          },
          false,
        );

        const session: Session = {
          user_id,
          device_id,
          access_token,
          passwordlessUser: true,
          tempPassword: password,
        };
        /* eslint-enable camelcase */

        // Set display name on the local client object for immediate UI consistency.
        // The proxy already set it server-side via the displayname field, but the
        // local User object won't have it until the next sync.
        const user = client.getUser(client.getUserId()!)!;
        user.setRawDisplayName(displayName);
        user.setDisplayName(displayName);

        logger.info("Guest registered via proxy", user_id);
        setClient(client, session);
      } else {
        // Fallback: standard UIA flow (upstream compatibility)
        try {
          const recaptchaResponse = await execute();
          const userName = generateRandomName();
          const [client, session] = await register(
            userName,
            secureRandomString(16),
            displayName,
            recaptchaResponse,
            true,
          );
          setClient(client, session);
        } catch (e) {
          reset();
          throw e;
        }
      }
    },
    [proxyUrl, execute, reset, register, setClient],
  );

  return { privacyPolicyUrl, registerPasswordlessUser, recaptchaId };
}
