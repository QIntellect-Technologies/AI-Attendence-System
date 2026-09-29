import React, { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { useOrg } from "../../contexts/OrgConfigContext";
import { JellyButton } from "./JellyButton";
import { Avatar } from "./Avatar";
import {
  confirmDialog,
  toastError,
  toastSuccess,
} from "../../utils/notifications";
import { imageFileToLogoDataUrl } from "../../utils/imageToDataUrl";
import {
  removeOrganizationLogo,
  saveOrganizationLogo,
} from "../../services/clintApi";

/**
 * Company logo upload/remove, rendered inline in AccountSettings' Organization
 * Profile card, next to the org name -- mirrors how My Profile puts the
 * person's avatar next to their name. Admin-only (AccountSettings gates it,
 * and PUT/DELETE /api/client/organization/logo enforces it server-side too).
 * After a change, OrgConfigContext is refreshed so the header updates at once.
 */
export const OrgLogoCard: React.FC = () => {
  const { cfg, refreshOrgConfig } = useOrg();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, successMessage: string) => {
    setBusy(true);
    try {
      await action();
      await refreshOrgConfig({ silent: true });
      toastSuccess(successMessage);
    } catch (err) {
      toastError(
        err instanceof Error ? err.message : "Could not update the logo.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow picking the same file again
    if (!file) return;
    void run(
      async () =>
        saveOrganizationLogo(await imageFileToLogoDataUrl(file), file.name),
      "Company logo updated.",
    );
  };

  const handleRemove = async () => {
    const result = await confirmDialog({
      title: "Remove company logo?",
      text: "The header will fall back to the default mark.",
      confirmButtonText: "Remove",
    });
    if (result.isConfirmed) {
      void run(removeOrganizationLogo, "Company logo removed.");
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <Avatar
        src={cfg.logo}
        label={cfg.orgName || "Company"}
        size={44}
        shape="rounded"
        fit="contain"
      />
      <JellyButton
        variant="secondary"
        size="sm"
        leftIcon={<ImagePlus />}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "Saving…" : cfg.logo ? "Change logo" : "Upload logo"}
      </JellyButton>
      {cfg.logo && (
        <JellyButton
          variant="ghost"
          size="sm"
          leftIcon={<Trash2 />}
          disabled={busy}
          onClick={() => void handleRemove()}
        >
          Remove
        </JellyButton>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFile}
        style={{ display: "none" }}
      />
    </div>
  );
};

export default OrgLogoCard;
