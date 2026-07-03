"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { Contact, Message } from "@/types";
import { formatRelativeTime, getInitials, cn } from "@/lib/utils";
import { useRealtimeMessageStatus } from "@/hooks/use-realtime";
import { Send, Search, Loader2, MessageSquareOff, FileDown, AlertCircle, Paperclip, X, Image, Video as VideoIcon, FileText, Headset } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "@/hooks/use-inbox-store";

interface InboxClientProps {
  initialContacts: Contact[];
}

// Request browser notification permission once
function requestNotificationPermission() {
  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function showBrowserNotification(title: string, body: string) {
  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.ico" });
  }
}

/** Detect media type from URL file extension */
function getMediaType(url: string): "image" | "video" | "audio" | "document" {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "webp", "gif", "svg", "heic"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm", "3gp"].includes(ext)) return "video";
  if (["mp3", "ogg", "m4a", "aac", "opus", "wav"].includes(ext)) return "audio";
  return "document";
}

/** Render the right element based on media type */
function MediaRenderer({ url, caption }: { url: string; caption?: string }) {
  const [imgError, setImgError] = useState(false);
  const type = getMediaType(url);
  const filename = url.split("/").pop()?.split("?")[0] ?? "file";

  if (type === "image") {
    if (imgError) {
      return (
        <div className="flex flex-col items-center gap-1.5 p-4 bg-muted/30 rounded-xl border border-border text-xs text-muted-foreground">
          <AlertCircle className="w-5 h-5" />
          <span>Image unavailable</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="underline text-primary">Open link</a>
        </div>
      );
    }
    return (
      <img
        src={url}
        alt={caption || "Image"}
        className="max-h-80 w-full object-contain rounded-xl"
        onError={() => setImgError(true)}
      />
    );
  }

  if (type === "video") {
    return (
      <video
        src={url}
        controls
        className="max-h-72 w-full rounded-xl"
        preload="metadata"
      >
        Your browser does not support video.
      </video>
    );
  }

  if (type === "audio") {
    return (
      <audio src={url} controls className="w-full">
        Your browser does not support audio.
      </audio>
    );
  }

  // Document / unknown
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-3 py-2.5 bg-muted/40 rounded-xl border border-border hover:bg-muted/60 transition-colors text-sm"
    >
      <FileDown className="w-4 h-4 shrink-0" />
      <span className="truncate max-w-[160px]">{filename}</span>
    </a>
  );
}

export function InboxClient({ initialContacts }: InboxClientProps) {
  const supabase = useMemo(() => createClient(), []);
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(initialContacts[0] ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [search, setSearch] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Refs to always have the latest value inside realtime closures (avoids stale closure bug)
  const selectedContactRef = useRef<Contact | null>(selectedContact);
  const contactsRef = useRef<Contact[]>(contacts);

  const incrementUnread = useInboxStore((state) => state.incrementUnread);
  const clearUnread = useInboxStore((state) => state.clearUnread);
  const setSelectedContactId = useInboxStore((state) => state.setSelectedContactId);
  const unreadCounts = useInboxStore((state) => state.unreadCounts);

  // Keep refs in sync with state
  useEffect(() => {
    selectedContactRef.current = selectedContact;
  }, [selectedContact]);

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  const filteredContacts = contacts.filter((c) =>
    (c.name ?? c.phone).toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search)
  );

  const scrollToBottom = useCallback(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }, []);

  const refreshMessages = useCallback(async (contactId: string) => {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", contactId)
      .order("sent_at", { ascending: true });

    if (error) {
      console.error("Failed to fetch messages:", error);
      return;
    }

    // REPLACE — never merge with previous contact's messages
    setMessages((data ?? []) as Message[]);
    scrollToBottom();
  }, [supabase, scrollToBottom]);

  const refreshContacts = useCallback(async () => {
    const { data, error } = await supabase
      .from("contacts")
      .select("*")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(50);

    if (error) {
      console.error("Failed to refresh contacts:", error);
      return;
    }

    if (data) {
      setContacts((prev) => {
        const merged = [...prev];
        data.forEach((contact) => {
          const index = merged.findIndex((item) => item.id === contact.id);
          if (index === -1) {
            merged.push(contact as Contact);
          } else {
            merged[index] = contact as Contact;
          }
        });

        return merged.sort((a, b) => {
          const aTime = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
          const bTime = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
          return bTime - aTime;
        });
      });
    }
  }, [supabase]);

  // Load messages when selected contact changes
  useEffect(() => {
    if (!selectedContact) return;
    // Clear immediately so the previous contact's messages never show in the new chat
    setMessages([]);
    setLoadingMessages(true);
    refreshMessages(selectedContact.id).finally(() => setLoadingMessages(false));
  }, [selectedContact?.id, refreshMessages]);

  // Auto-select first contact if none selected
  useEffect(() => {
    if (selectedContact || contacts.length === 0) return;
    const firstContact = contacts[0];
    setSelectedContact(firstContact);
    setSelectedContactId(firstContact.id);
  }, [contacts, selectedContact, setSelectedContactId]);

  // Initial contact load refresh
  useEffect(() => {
    refreshContacts();
  }, [refreshContacts]);

  // Request browser notification permission on mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Update message status in real time (delivered / read ticks)
  useRealtimeMessageStatus((id, status) => {
    setMessages((prev) =>
      prev.map((msg) => (msg.id === id ? { ...msg, status: status as Message["status"] } : msg))
    );
  });

  // ─── Single realtime channel — created ONCE on mount ─────────────────────
  // Uses refs (selectedContactRef, contactsRef) so the closure never goes stale.
  useEffect(() => {
    const channel = supabase
      .channel("inbox-messages-realtime", {
        config: { broadcast: { self: false } },
      })
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const incoming = payload.new as Message;

          // Only handle inbound messages
          if (incoming.direction !== "inbound") return;

          // Deduplicate
          if (!incoming.id || seenMessageIdsRef.current.has(incoming.id)) return;
          seenMessageIdsRef.current.add(incoming.id);

          // Read latest refs — no stale closure
          const currentSelected = selectedContactRef.current;
          const currentContacts = contactsRef.current;

          // If this is a new contact not in the list yet, refresh contacts
          const matchedContact = currentContacts.find((c) => c.id === incoming.contact_id);

          if (!matchedContact) {
            // New contact — refresh list then show notification
            refreshContacts();
          }

          // If viewing a different (or no) contact, show notification + badge
          if (incoming.contact_id !== currentSelected?.id) {
            incrementUnread(incoming.contact_id);

            const contactName = matchedContact?.name ?? matchedContact?.phone ?? "Unknown";
            const toastMsg = matchedContact
              ? `New message from ${contactName}`
              : "New message received";

            toast.success(toastMsg, {
              description: incoming.content !== "[media]" ? incoming.content : "📎 Media",
              duration: 5000,
            });

            showBrowserNotification("New WhatsApp Message", `${contactName}: ${
              incoming.content !== "[media]" ? incoming.content : "📎 Media"
            }`);
          }

          // If this contact is currently open, append message immediately
          if (currentSelected?.id === incoming.contact_id) {
            setMessages((prev) => {
              if (prev.find((m) => m.id === incoming.id)) return prev;
              const updated = [...prev, incoming].sort(
                (a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime()
              );
              return updated;
            });
            scrollToBottom();
          }

          // Always refresh contact list to update last_message_at ordering
          refreshContacts();
        }
      )
      .subscribe((status, err) => {
        console.log("[Inbox] Realtime channel status:", status, err ?? "");
        if (status === "CHANNEL_ERROR") {
          console.error("[Inbox] Realtime channel error:", err);
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]); // Only depend on supabase — contacts/selectedContact accessed via refs


  const sendReply = async () => {
    if (!selectedContact) return;

    const hasText = !!replyText.trim();
    const hasFile = !!selectedFile;
    if (!hasText && !hasFile) return;

    setSending(true);

    try {
      let mediaUrl: string | null = null;
      let mediaType: string | null = null;
      let filename: string | null = null;

      if (selectedFile) {
        setUploading(true);
        const formData = new FormData();
        formData.append("file", selectedFile);

        const uploadRes = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) {
          const errData = await uploadRes.json().catch(() => ({}));
          throw new Error(errData.error || "Failed to upload attachment");
        }

        const uploadData = await uploadRes.json();
        mediaUrl = uploadData.url;
        filename = uploadData.name;

        const mime = selectedFile.type;
        if (mime.startsWith("image/")) {
          mediaType = "image";
        } else if (mime.startsWith("video/")) {
          mediaType = "video";
        } else if (mime.startsWith("audio/")) {
          mediaType = "audio";
        } else {
          mediaType = "document";
        }
        setUploading(false);
      }

      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: selectedContact.id,
          phone: selectedContact.phone,
          message: replyText.trim() || undefined,
          media_url: mediaUrl,
          media_type: mediaType,
          filename: filename,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to send");
      }

      setReplyText("");
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      // Refresh messages after sending to show the outbound message
      await refreshMessages(selectedContact.id);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to send message");
    } finally {
      setUploading(false);
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  };

  // Render message status ticks with visual distinction
  function MessageStatusTick({ status }: { status: string }) {
    if (status === "read") {
      return (
        <span className="ml-1" style={{ color: "#53bdeb" }} title="Read">
          ✓✓
        </span>
      );
    }
    if (status === "delivered") {
      return (
        <span className="ml-1 opacity-70" title="Delivered">
          ✓✓
        </span>
      );
    }
    // sent / pending
    return (
      <span className="ml-1 opacity-50" title="Sent">
        ✓
      </span>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] bg-card border border-border rounded-2xl overflow-hidden animate-fade-in">
      {/* Contacts sidebar */}
      <div className="w-72 shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts..."
              className="w-full pl-8 pr-3 py-2 bg-background border border-input rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {filteredContacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-4">
              <p className="text-xs text-muted-foreground">No contacts yet</p>
            </div>
          ) : (
            filteredContacts.map((contact) => {
              const unreadCount = unreadCounts[contact.id] ?? 0;
              return (
                <button
                  key={contact.id}
                  onClick={() => {
                    setSelectedContact(contact);
                    setSelectedContactId(contact.id);
                    clearUnread(contact.id);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 p-3 hover:bg-muted/40 transition-colors text-left border-b border-border/50",
                    selectedContact?.id === contact.id && "bg-muted/60"
                  )}
                >
                  <div className="relative w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="text-xs font-semibold text-primary">
                      {getInitials(contact.name, contact.phone)}
                    </span>
                    {unreadCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-green-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                        {unreadCount > 9 ? "9+" : unreadCount}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className={cn(
                        "text-sm truncate",
                        unreadCount > 0 ? "font-semibold text-foreground" : "font-medium text-foreground"
                      )}>
                        {contact.name ?? contact.phone}
                      </p>
                      <span suppressHydrationWarning className="text-xs text-muted-foreground shrink-0 ml-1">
                        {formatRelativeTime(contact.last_message_at)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{contact.phone}</p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        {!selectedContact ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
              <MessageSquareOff className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Select a conversation</p>
            <p className="text-xs text-muted-foreground mt-1">Choose a contact from the sidebar to start chatting</p>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
                <span className="text-xs font-semibold text-primary">
                  {getInitials(selectedContact.name, selectedContact.phone)}
                </span>
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {selectedContact.name ?? selectedContact.phone}
                </p>
                <p className="text-xs text-muted-foreground">{selectedContact.phone}</p>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
              {loadingMessages ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full">
                  <p className="text-xs text-muted-foreground">No messages yet</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      "flex",
                      msg.direction === "outbound" ? "justify-end" : "justify-start"
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[70%] px-3.5 py-2.5 rounded-2xl text-sm",
                        msg.direction === "outbound"
                          ? "bg-primary text-primary-foreground rounded-br-sm"
                          : "bg-muted text-foreground rounded-bl-sm"
                      )}
                    >
                      {msg.media_url ? (
                        <div className="space-y-1.5">
                          <MediaRenderer
                            url={msg.media_url}
                            caption={
                              msg.content && !["[media]", "[image]", "[video]", "[audio]", "[document]", "[sticker]"].includes(msg.content)
                                ? msg.content
                                : undefined
                            }
                          />
                          {msg.content && !["[media]", "[image]", "[video]", "[audio]", "[document]", "[sticker]"].includes(msg.content) ? (
                            <p>{msg.content}</p>
                          ) : null}
                        </div>
                      ) : ["[image]", "[video]", "[audio]", "[document]", "[sticker]", "[media]"].includes(msg.content) ? (
                        <div className="flex items-center gap-2 text-xs opacity-70 italic">
                          <span>📎</span>
                          <span>{msg.content.replace(/\[|\]/g, "")} — media unavailable</span>
                        </div>
                      ) : (
                        <p>{msg.content}</p>
                      )}
                      <p className={cn(
                        "text-xs mt-1 flex items-center gap-0.5",
                        msg.direction === "outbound" ? "text-primary-foreground/60 justify-end" : "text-muted-foreground"
                      )}>
                        {new Date(msg.sent_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                        {msg.direction === "outbound" && (
                          <MessageStatusTick status={msg.status} />
                        )}
                      </p>
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply box */}
            <div className="p-3 border-t border-border flex flex-col gap-2 bg-card">
              {selectedFile && (
                <div className="relative flex items-center gap-3 p-3 bg-muted/40 rounded-xl border border-border/80 animate-fade-in max-w-sm">
                  {/* File icon or Image Thumbnail preview */}
                  <div className="w-12 h-12 rounded-lg bg-background border border-border flex items-center justify-center overflow-hidden shrink-0">
                    {selectedFile.type.startsWith("image/") ? (
                      <img
                        src={URL.createObjectURL(selectedFile)}
                        alt="Preview"
                        className="w-full h-full object-cover"
                      />
                    ) : selectedFile.type.startsWith("video/") ? (
                      <VideoIcon className="w-5 h-5 text-indigo-500 animate-pulse" />
                    ) : selectedFile.type.startsWith("audio/") ? (
                      <Headset className="w-5 h-5 text-emerald-500 animate-pulse" />
                    ) : (
                      <FileText className="w-5 h-5 text-amber-500" />
                    )}
                  </div>
                  
                  {/* File Meta Info */}
                  <div className="flex-1 min-w-0 pr-6">
                    <p className="text-xs font-medium text-foreground truncate">{selectedFile.name}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • {selectedFile.type.split("/")[1]?.toUpperCase() || "FILE"}
                    </p>
                  </div>

                  {/* Remove Button */}
                  <button
                    onClick={() => {
                      setSelectedFile(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                    className="absolute top-2 right-2 p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              <div className="flex items-end gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    if (file) {
                      setSelectedFile(file);
                    }
                  }}
                  className="hidden"
                  accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
                />
                
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-10 h-10 flex items-center justify-center bg-muted/65 hover:bg-muted hover:text-foreground text-muted-foreground rounded-xl transition-all shrink-0 border border-border"
                  title="Attach media (images, videos, audio, documents)"
                >
                  <Paperclip className="w-4 h-4" />
                </button>

                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={selectedFile ? "Add a caption... (Enter to send)" : "Type a message... (Enter to send)"}
                  rows={1}
                  className="flex-1 px-3 py-2.5 bg-background border border-input rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring max-h-32 scrollbar-thin"
                  style={{ minHeight: "40px" }}
                />
                
                <button
                  onClick={sendReply}
                  disabled={sending || uploading || (!replyText.trim() && !selectedFile)}
                  className="w-10 h-10 flex items-center justify-center bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-all disabled:opacity-50 shrink-0"
                >
                  {sending || uploading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
