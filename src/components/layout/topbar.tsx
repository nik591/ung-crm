"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Moon, Sun, LogOut, Bell } from "lucide-react";
import { useTheme } from "next-themes";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { User } from "@supabase/supabase-js";
import { useInboxStore } from "@/hooks/use-inbox-store";

const pageTitles: Record<string, string> = {
  "/dashboard": "Overview",
  "/dashboard/inbox": "Inbox",
  "/dashboard/campaigns": "Campaigns",
  "/dashboard/contacts": "Contacts",
  "/dashboard/analytics": "Analytics",
};

interface TopbarProps {
  user: User;
}

export function Topbar({ user }: TopbarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const supabase = useMemo(() => createClient(), []);
  const unreadCounts = useInboxStore((state) => state.unreadCounts);
  const unreadTotal = Object.values(unreadCounts).reduce((sum, value) => sum + value, 0);
  const incrementUnread = useInboxStore((state) => state.incrementUnread);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  const title = pageTitles[pathname] ?? "Dashboard";

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let active = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const connect = async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!active || !session?.access_token) return;

      channel = supabase.channel("messages:topbar-realtime");
      channel
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages" },
          (payload) => {
            const newMessage = payload.new as { id?: string; direction?: string; contact_id?: string };
            if (newMessage?.direction !== "inbound") return;
            if (!newMessage.id || seenMessageIdsRef.current.has(newMessage.id)) return;

            seenMessageIdsRef.current.add(newMessage.id);
            if (newMessage.contact_id) incrementUnread(newMessage.contact_id);
            toast.success("New incoming message");
          }
        )
        .subscribe((status) => {
          console.log("Topbar realtime status:", status);
        });
    };

    void connect();

    return () => {
      active = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [incrementUnread, supabase]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out");
    router.push("/auth/login");
    router.refresh();
  };

  return (
    <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm shrink-0">
      <h1 className="text-base font-semibold text-foreground">{title}</h1>

      <div className="flex items-center gap-2">
        <button
          className="relative w-9 h-9 flex items-center justify-center rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
          title="Notifications"
        >
          <Bell className="w-4 h-4" />
          {unreadTotal > 0 && (
            <span className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-white">
              {unreadTotal}
            </span>
          )}
        </button>

        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
          title="Toggle theme"
        >
          {mounted ? (
            theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />
          ) : (
            <Sun className="w-4 h-4 opacity-0" />
          )}
        </button>

        <button
          onClick={handleSignOut}
          className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-muted text-muted-foreground hover:text-destructive transition-all"
          title="Sign out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
