import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { formatPhone } from "@/lib/utils";

const META_API_VERSION = process.env.META_API_VERSION ?? "v20.0";
const META_API = `https://graph.facebook.com/${META_API_VERSION}`;
const STORAGE_BUCKET = process.env.SUPABASE_MEDIA_BUCKET ?? "whatsapp-media";

async function fetchMediaUrl(mediaId: string) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) return null;

  const res = await fetch(`${META_API}/${mediaId}?fields=url`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("Failed to fetch media URL", mediaId, body);
    return null;
  }

  const data = await res.json();
  return data.url ?? null;
}

function getExtensionFromMimeType(mimeType?: string) {
  if (!mimeType) return "bin";
  const type = mimeType.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/opus": "opus",
    "application/pdf": "pdf",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  return map[type] ?? type.split("/")[1] ?? "bin";
}

async function downloadMediaFile(mediaUrl: string) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) return null;

  const res = await fetch(mediaUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("Failed to download media file", mediaUrl, body);
    return null;
  }

  const contentType = res.headers.get("content-type") ?? undefined;
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

async function ensureBucketExists(supabase: any): Promise<boolean> {
  // Check if bucket already exists
  const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    console.error("[Media] Could not list buckets:", listErr);
    return false;
  }
  const exists = (buckets ?? []).some((b: { name: string }) => b.name === STORAGE_BUCKET);
  if (exists) return true;

  // Create the bucket as public
  console.log(`[Media] Bucket "${STORAGE_BUCKET}" not found — creating it as public...`);
  const { error: createErr } = await supabase.storage.createBucket(STORAGE_BUCKET, {
    public: true,
    fileSizeLimit: 52428800, // 50 MB
    allowedMimeTypes: null,  // allow all
  });
  if (createErr) {
    console.error("[Media] Failed to create bucket:", createErr);
    return false;
  }
  console.log(`[Media] Bucket "${STORAGE_BUCKET}" created successfully.`);
  return true;
}

async function uploadMediaToStorage(supabase: any, path: string, data: Buffer, contentType?: string) {
  console.log("[Media] Uploading to storage:", path, "| type:", contentType, "| size:", data.length, "bytes");

  // Ensure bucket exists before uploading
  const bucketReady = await ensureBucketExists(supabase);
  if (!bucketReady) {
    console.error("[Media] Bucket not ready — skipping upload.");
    return null;
  }

  const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(path, data, {
    contentType,
    upsert: true,
  });

  if (uploadError) {
    console.error("[Media] Upload failed:", JSON.stringify(uploadError));
    return null;
  }

  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  if (!urlData?.publicUrl) {
    console.error("[Media] getPublicUrl returned empty — bucket may not be public.");
    return null;
  }

  console.log("[Media] ✓ Upload success:", urlData.publicUrl);
  return urlData.publicUrl;
}

// GET: Meta webhook verification
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

// POST: Receive incoming messages and delivery status updates
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    console.log("========== WEBHOOK PAYLOAD ==========");
    console.log(JSON.stringify(body, null, 2));
    console.log("=====================================");

    if (body.object !== "whatsapp_business_account") {
      return NextResponse.json({ status: "ignored" });
    }

    const supabase = await createAdminClient();

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;

        // Handle incoming messages
        if (value.messages) {
          for (const msg of value.messages) {
            try {
              const phone = formatPhone(msg.from);
              const contact = value.contacts?.find((c: { wa_id: string }) => c.wa_id === msg.from);
              const name = contact?.profile?.name ?? null;

              let content = "";
              let mediaId: string | null = null;
              let mediaType: string | null = null;

              switch (msg.type) {
                case "text":
                  content = msg.text?.body ?? "";
                  break;
                case "image":
                  mediaId = msg.image?.id ?? null;
                  mediaType = "image";
                  content = msg.image?.caption ?? "";
                  break;
                case "video":
                  mediaId = msg.video?.id ?? null;
                  mediaType = "video";
                  content = msg.video?.caption ?? "";
                  break;
                case "document":
                  mediaId = msg.document?.id ?? null;
                  mediaType = "document";
                  content = msg.document?.caption ?? msg.document?.filename ?? "";
                  break;
                case "audio":
                  mediaId = msg.audio?.id ?? null;
                  mediaType = "audio";
                  content = msg.audio?.caption ?? "";
                  break;
                case "sticker":
                  mediaId = msg.sticker?.id ?? null;
                  mediaType = "sticker";
                  content = "";
                  break;
                case "location":
                  const loc = msg.location;
                  if (loc) {
                    const locName = loc.name ? ` - ${loc.name}` : "";
                    const locAddr = loc.address ? ` (${loc.address})` : "";
                    content = `📍 Location: Lat ${loc.latitude}, Lng ${loc.longitude}${locName}${locAddr}`;
                  } else {
                    content = "📍 Location shared";
                  }
                  break;
                case "contacts":
                  const firstContact = msg.contacts?.[0];
                  if (firstContact) {
                    const cName = firstContact.name?.formatted_name ?? "Contact";
                    const cPhone = firstContact.phones?.[0]?.phone ?? "";
                    content = `📇 Contact: ${cName}${cPhone ? ` (${cPhone})` : ""}`;
                  } else {
                    content = "📇 Contact card shared";
                  }
                  break;
                case "interactive":
                  const interactive = msg.interactive;
                  if (interactive?.type === "button_reply") {
                    content = interactive.button_reply?.title ?? "";
                  } else if (interactive?.type === "list_reply") {
                    content = interactive.list_reply?.title ?? "";
                  } else {
                    content = "[Interactive message response]";
                  }
                  break;
                case "button":
                  content = msg.button?.text ?? "";
                  break;
                default:
                  content = `[Unsupported message type: ${msg.type}]`;
                  break;
              }

              // content priority: extracted content -> fallback media label -> "[unsupported message]"
              if (!content) {
                if (mediaType) {
                  if (mediaType === "audio" && msg.audio?.voice) {
                    content = "[voice note]";
                  } else {
                    content = `[${mediaType}]`;
                  }
                } else {
                  content = "[message]";
                }
              }

              let mediaUrl: string | null = null;
              if (mediaId) {
                const tempUrl = await fetchMediaUrl(mediaId);
                if (tempUrl) {
                  const downloaded = await downloadMediaFile(tempUrl);
                  if (downloaded) {
                    const extension = getExtensionFromMimeType(downloaded.contentType);
                    const filename = `${msg.id}.${extension}`;
                    const storagePath = `whatsapp/${filename}`;
                    mediaUrl = await uploadMediaToStorage(supabase, storagePath, downloaded.buffer, downloaded.contentType);
                  }
                }
              }

              const wamid = msg.id;

              // Upsert contact
              const { data: upsertedContact, error: upsertError } = await supabase
                .from("contacts")
                .upsert(
                  { phone, name, last_message_at: new Date().toISOString() },
                  { onConflict: "phone" }
                )
                .select("id");

              if (upsertError) {
                console.error("Contact upsert error:", upsertError);
              }
              const contactRecord = Array.isArray(upsertedContact) ? upsertedContact[0] : upsertedContact;

              if (contactRecord) {
                const { data: insertedMessage, error: insertError } = await supabase.from("messages").insert({
                  contact_id: contactRecord.id,
                  wamid,
                  direction: "inbound",
                  content,
                  media_url: mediaUrl,
                  status: "delivered",
                  sent_at: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
                  delivered_at: new Date().toISOString(),
                }).select();

                if (insertError) {
                  console.error("Message insert error:", insertError);
                } else {
                  console.log("Inserted message:", insertedMessage);
                }

                // Increment message count
                await supabase
                  .from("contacts")
                  .update({
                    last_message_at: new Date().toISOString(),
                  })
                  .eq("id", contactRecord.id);

                // Use raw SQL increment
                const { error: rpcErr } = await supabase.rpc("increment_message_count", { contact_id: contactRecord.id });
                if (rpcErr) console.error("increment_message_count error:", rpcErr);
              }
            } catch (msgErr) {
              console.error("Error processing message:", msgErr, msg);
            }
          }
        }

        // Handle delivery status updates
        if (value.statuses) {
          for (const status of value.statuses) {
            try {
              const wamid = status.id;
              const newStatus: string = status.status;
              const now = new Date().toISOString();

              console.log("STATUS UPDATE:", wamid, newStatus);

              // Build update object for messages
              const messageUpdate: Record<string, string> = { status: newStatus };
              if (newStatus === "delivered") messageUpdate.delivered_at = now;
              if (newStatus === "read") {
                messageUpdate.delivered_at = now;
                messageUpdate.read_at = now;
              }

              // Update message status
              const { error: messageStatusError } = await supabase
                .from("messages")
                .update(messageUpdate)
                .eq("wamid", wamid);

              if (messageStatusError) {
                console.error("Failed to update message status:", messageStatusError, { wamid, newStatus });
              }

              // Update campaign log status
              const { data: log, error: logError } = await supabase
                .from("campaign_logs")
                .update({ ...messageUpdate })
                .eq("wamid", wamid)
                .select("campaign_id")
                .maybeSingle();

              if (logError) {
                console.error("Failed to update campaign log status:", logError, { wamid, newStatus });
              }

              // Update campaign counts directly
              if (log?.campaign_id) {
                const campaignId = log.campaign_id;

                if (newStatus === "delivered") {
                  await supabase.rpc("increment_campaign_count", {
                    p_campaign_id: campaignId,
                    p_field: "delivered_count",
                  });
                } else if (newStatus === "read") {
                  await supabase.rpc("increment_campaign_count", {
                    p_campaign_id: campaignId,
                    p_field: "read_count",
                  });
                } else if (newStatus === "failed") {
                  await supabase.rpc("increment_campaign_count", {
                    p_campaign_id: campaignId,
                    p_field: "failed_count",
                  });
                }
              }
            } catch (statusErr) {
              console.error("Error processing status update:", statusErr, status);
            }
          }
        }
      }
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("Webhook error:", err);
    return NextResponse.json({ status: "error" }, { status: 200 });
  }
}
