import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsAppText, sendWhatsAppMedia } from "@/services/meta";

export async function POST(req: NextRequest) {
  try {
    const { contact_id, phone, message, media_url, media_type, filename } = await req.json();

    if (!contact_id || !phone) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (!message && !media_url) {
      return NextResponse.json({ error: "Either message or media_url is required" }, { status: 400 });
    }

    const supabase = await createAdminClient();
    let ok = false;
    let wamid = null;
    let error = null;

    if (media_url) {
      const result = await sendWhatsAppMedia(
        phone,
        media_url,
        media_type || "image",
        message || undefined,
        filename
      );
      ok = result.ok;
      wamid = result.wamid;
      error = result.error;
    } else {
      const result = await sendWhatsAppText(phone, message);
      ok = result.ok;
      wamid = result.wamid;
      error = result.error;
    }

    if (!ok) {
      throw new Error(error ?? "Meta API failed");
    }

    // Determine the content to save in the database
    let contentToSave = message || "";
    if (media_url && !contentToSave) {
      contentToSave = `[${media_type || "image"}]`;
    }

    const { data: savedMessage, error: msgError } = await supabase
      .from("messages")
      .insert({
        contact_id,
        direction: "outbound",
        content: contentToSave,
        media_url: media_url || null,
        wamid,
        status: "sent",
        sent_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (msgError) throw new Error(msgError.message);

    await supabase
      .from("contacts")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", contact_id);

    return NextResponse.json({ success: true, message_id: savedMessage.id, wamid });
  } catch (err) {
    console.error("Message send error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const contactId = searchParams.get("contact_id");

    if (!contactId) {
      return NextResponse.json({ error: "contact_id required" }, { status: 400 });
    }

    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", contactId)
      .order("sent_at", { ascending: true });

    if (error) throw error;
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to fetch messages" }, { status: 500 });
  }
}
