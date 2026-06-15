import * as React from "react";
import { Satellite, Sun, Moon, Github } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  OverviewView, LifecycleView, McpView, BrainView, MeetView, PersonaView, DataView, OpsView,
} from "@/components/views";

const TABS: { value: string; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "lifecycle", label: "Request Lifecycle" },
  { value: "mcp", label: "MCP Servers" },
  { value: "brain", label: "Company Brain" },
  { value: "meet", label: "Meet Bot" },
  { value: "persona", label: "Persona" },
  { value: "data", label: "Data Model" },
  { value: "ops", label: "Ops & Config" },
];

function useTheme() {
  const [dark, setDark] = React.useState(true);
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export default function App() {
  const [tab, setTab] = React.useState("overview");
  const { dark, toggle } = useTheme();

  React.useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <Tabs value={tab} onValueChange={setTab} className="min-h-screen">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1520px] flex-wrap items-center gap-4 px-6 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-[var(--brain)] shadow-lg shadow-primary/30">
              <Satellite className="size-4 text-primary-foreground" />
            </span>
            <div className="leading-tight">
              <div className="text-[15px] font-bold tracking-tight">Sentinel</div>
              <div className="text-[11px] text-muted-foreground">interactive technical explainer</div>
            </div>
          </div>

          <div className="order-3 w-full overflow-x-auto pb-1 lg:order-2 lg:ml-auto lg:w-auto lg:pb-0">
            <TabsList className="bg-secondary/50">
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="order-2 ml-auto flex items-center gap-1 lg:order-3 lg:ml-0">
            <Button variant="ghost" size="icon" onClick={toggle} title="Toggle theme">
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Button variant="ghost" size="icon" asChild title="Newton School · Sentinel">
              <a href="https://newtonschool.co" target="_blank" rel="noreferrer"><Github className="size-4" /></a>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1520px] px-6 pb-24 pt-7">
        <TabsContent value="overview"><OverviewView /></TabsContent>
        <TabsContent value="lifecycle"><LifecycleView /></TabsContent>
        <TabsContent value="mcp"><McpView /></TabsContent>
        <TabsContent value="brain"><BrainView /></TabsContent>
        <TabsContent value="meet"><MeetView /></TabsContent>
        <TabsContent value="persona"><PersonaView /></TabsContent>
        <TabsContent value="data"><DataView /></TabsContent>
        <TabsContent value="ops"><OpsView /></TabsContent>
      </main>

      <footer className="border-t">
        <div className="mx-auto max-w-[1520px] px-6 py-5 text-xs text-muted-foreground">
          Sentinel · founders-only leadership data bot for Newton School · built with the Claude CLI, 9 MCP servers, a Playwright Meet pipeline, and a SQLite company brain.
        </div>
      </footer>
    </Tabs>
  );
}
