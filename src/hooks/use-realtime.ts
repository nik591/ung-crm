"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { Message } from "@/types";

interface UseRealtimeMessagesOptions {
  contactId: string | null;
  onMessage: (message: Message) => void;
}

export function useRealtimeMessages({ contactId, onMessage }: UseRealtimeMessagesOptions) {
  const supabase = createClient();

  useEffect(() => {
    if (!contactId) return;

    const channel = supabase
      .channel(`messages-${contactId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `contact_id=eq.${contactId}`,
        },
        (payload) => {
          onMessage(payload.new as Message);
        }
      )
      .subscribe((status, err) => {
        if (err) console.error("[useRealtimeMessages] subscribe error:", err);
        else console.log("[useRealtimeMessages] status:", status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Subscribes to ALL message UPDATE events and calls onUpdate(id, status).
 * Requires the messages table to have REPLICA IDENTITY FULL in Supabase.
 */
export function useRealtimeMessageStatus(onUpdate: (id: string, status: string) => void) {
  // Keep onUpdate in a ref so the channel closure never goes stale
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  });

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("message-status-updates", {
        config: { broadcast: { self: false } },
      })
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
        },
        (payload) => {
          const updated = payload.new;
          if (updated?.id && updated?.status) {
            console.log("[useRealtimeMessageStatus] status update:", updated.id, updated.status);
            onUpdateRef.current(updated.id, updated.status);
          }
        }
      )
      .subscribe((status, err) => {
        if (err) console.error("[useRealtimeMessageStatus] subscribe error:", err);
        else console.log("[useRealtimeMessageStatus] channel status:", status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []); // Intentionally empty — stable via ref
}
