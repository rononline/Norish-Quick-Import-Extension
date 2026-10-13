import { useState, useEffect } from "react";
import { getChromeRuntimeError, isExtensionContextValid } from "../lib/chrome";

export function useCurrentTabUrl(): string {
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!isExtensionContextValid()) return;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (getChromeRuntimeError()) return;

      const tabUrl = tabs?.[0]?.url;
      if (tabUrl) setUrl(tabUrl);
    });
  }, []);

  return url;
}

/** The active tab's ID and URL (the ID is needed to read the page). */
export function useCurrentTab(): { id?: number; url: string } {
  const [tab, setTab] = useState<{ id?: number; url: string }>({ url: "" });

  useEffect(() => {
    if (!isExtensionContextValid()) return;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (getChromeRuntimeError()) return;

      const active = tabs?.[0];
      if (active?.url) setTab({ id: active.id, url: active.url });
    });
  }, []);

  return tab;
}
