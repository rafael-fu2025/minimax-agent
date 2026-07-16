import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { RefreshCwIcon } from "lucide-react";
import { fetchTools, type ToolsResponse } from "../api";
import { ToolsTab } from "./ToolsTab";
import { ServerTab } from "./ServerTab";
import { KeysTab } from "./KeysTab";
import { UsageTab } from "./UsageTab";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabKey = "tools" | "server" | "keys" | "usage" | "about";

/**
 * Settings dialog: three tabs (Tools, Server, About). Fetches the live tool
 * registry + server config from `GET /api/tools` on first open and whenever
 * the user clicks Refresh.
 */
export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("tools");
  const [data, setData] = useState<ToolsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTools();
      if (!result.ok) {
        setError(result.error || "Could not reach the server.");
      } else {
        setData(result.data);
      }
    } catch (err) {
      setError((err as Error).message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch the first time the dialog opens. Re-fetches when re-opened only
  // if we don't already have data (manual refresh button bypasses the cache).
  useEffect(() => {
    if (isOpen && !data && !loading) {
      void refetch();
    }
  }, [isOpen, data, loading, refetch]);

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={720}
      maxHeight="80vh"
      purpose="info"
    >
      <VStack gap={3} className="settings-dialog__body">
        <div className="settings-dialog__header">
          <Text type="display-3" as="h2">
            Settings
          </Text>
          <Button
            label="Refresh"
            variant="ghost"
            size="sm"
            onClick={() => void refetch()}
            isDisabled={loading}
            icon={<Icon icon={RefreshCwIcon} size="sm" />}
          />
        </div>

        {error && (
          <Banner
            status="error"
            title="Couldn't load server config"
            description={error}
            endContent={
              <Button
                label="Retry"
                variant="ghost"
                size="sm"
                onClick={() => void refetch()}
              />
            }
          />
        )}

        <TabList value={activeTab} onChange={(v) => setActiveTab(v as TabKey)}>
          <Tab value="tools" label="Tools" />
          <Tab value="server" label="Server" />
          <Tab value="keys" label="Keys" />
          <Tab value="usage" label="Usage" />
          <Tab value="about" label="About" />
        </TabList>

        <div className="settings-dialog__pane">
          {loading && !data ? (
            <div className="settings-dialog__loading">
              <Spinner size="lg" label="Loading server config…" />
            </div>
          ) : activeTab === "tools" ? (
            <ToolsTab data={data} loading={loading} onRefresh={refetch} />
          ) : activeTab === "server" ? (
            <ServerTab data={data} />
          ) : activeTab === "keys" ? (
            <KeysTab />
          ) : activeTab === "usage" ? (
            <UsageTab />
          ) : (
            <AboutTab />
          )}
        </div>

        <div className="settings-dialog__footer">
          <Button label="Close" variant="secondary" onClick={onClose} />
        </div>
      </VStack>
    </Dialog>
  );
}

function AboutTab() {
  return (
    <VStack gap={3} className="about-tab">
      <Banner
        status="info"
        title="Astryx × MiniMax Agent"
        description="An agentic chatbot with a streaming UI built on Meta's Astryx design system, MiniMax chat models, and a Postgres + pgvector persistence layer."
      />
      <Banner
        status="success"
        title="What's wired up"
        description="Server-side conversations + messages + vector memory (8 native tools + optional MCP servers). The settings panel reflects the live tool registry."
      />
      <Text type="supporting">
        Auth UI ships when the server-side auth slice lands. Until then, the
        server runs single-tenant and the API is unauthenticated.
      </Text>
    </VStack>
  );
}
