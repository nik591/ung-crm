import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsAppTemplate } from "@/services/meta";
import { SendCampaignPayload } from "@/types";

export async function POST(req: NextRequest) {
  try {
    const body: SendCampaignPayload = await req.json();
    const { campaign_name, template_name, template_language, contacts, headerVideoUrl, headerImageUrl, headerMediaUrl } = body;

    if (!campaign_name || !template_name || !contacts?.length) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const supabase = await createAdminClient();

    // Create campaign
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: campaign_name,
        template_name,
        template_language,
        status: "running",
        total_contacts: contacts.length,
      })
      .select()
      .single();

    if (campaignError || !campaign) {
      throw new Error(campaignError?.message ?? "Failed to create campaign");
    }

    // Upsert contacts
    const { data: upsertedContacts } = await supabase
      .from("contacts")
      .upsert(
        contacts.map((c) => ({ phone: c.phone, name: c.name ?? null, email: c.email ?? null })),
        { onConflict: "phone", ignoreDuplicates: false }
      )
      .select("id, phone, name");

    if (!upsertedContacts?.length) {
      throw new Error("Failed to upsert contacts");
    }

    // Fetch template details from Meta to check for header format & body variables
    const wabaId = process.env.META_WABA_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;
    let hasVideoHeader = false;
    let hasImageHeader = false;
    let hasBodyVariables = false;

    if (wabaId && accessToken) {
      try {
        const templatesRes = await fetch(
          `https://graph.facebook.com/v19.0/${wabaId}/message_templates?name=${encodeURIComponent(template_name)}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (templatesRes.ok) {
          const templatesData = await templatesRes.json();
          const matchingTemplate = (templatesData.data ?? []).find(
            (t: any) =>
              t.name === template_name &&
              (t.language === template_language || t.language?.startsWith(template_language))
          );

          if (matchingTemplate && matchingTemplate.components) {
            const headerComponent = matchingTemplate.components.find(
              (c: any) => c.type === "HEADER"
            );
            if (headerComponent?.format === "VIDEO") {
              hasVideoHeader = true;
            } else if (headerComponent?.format === "IMAGE") {
              hasImageHeader = true;
            }

            const bodyComponent = matchingTemplate.components.find(
              (c: any) => c.type === "BODY"
            );
            if (bodyComponent?.text) {
              hasBodyVariables = /\{\{\d+\}\}/.test(bodyComponent.text);
            }
          }
        }
      } catch (err) {
        console.error("Error fetching template metadata from Meta:", err);
      }
    }

    let sentCount = 0;
    let failedCount = 0;
    const failReasons: string[] = [];

    for (const contact of upsertedContacts) {
      let headerMedia: { type: "video" | "image"; url: string } | null = null;
      if (hasVideoHeader && (headerVideoUrl || headerMediaUrl)) {
        headerMedia = { type: "video", url: (headerVideoUrl || headerMediaUrl)! };
      } else if (hasImageHeader && (headerImageUrl || headerMediaUrl)) {
        headerMedia = { type: "image", url: (headerImageUrl || headerMediaUrl)! };
      }

      const { ok, wamid, error } = await sendWhatsAppTemplate(
        contact.phone,
        template_name,
        template_language,
        headerMedia,
        contact.name ?? undefined,
        hasBodyVariables
      );

      await supabase.from("campaign_logs").insert({
        campaign_id: campaign.id,
        contact_id: contact.id,
        wamid: wamid ?? null,
        status: ok ? "sent" : "failed",
        error_message: error ?? null,
        sent_at: new Date().toISOString(),
      });

      await supabase.from("messages").insert({
        contact_id: contact.id,
        campaign_id: campaign.id,
        wamid: wamid ?? null,
        direction: "outbound",
        content: `📢 ${campaign_name} — Template: ${template_name}`,
        status: ok ? "sent" : "failed",
        sent_at: new Date().toISOString(),
      });

      if (ok) {
        sentCount++;
        await supabase
          .from("contacts")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", contact.id);
      } else {
        failedCount++;
        if (error) {
          failReasons.push(`${contact.phone}: ${error}`);
        }
        console.error(`Failed to send to ${contact.phone}:`, error);
      }
    }

    await supabase
      .from("campaigns")
      .update({
        status: sentCount === 0 ? "failed" : failedCount === contacts.length ? "failed" : "completed",
        sent_count: sentCount,
        failed_count: failedCount,
        completed_at: new Date().toISOString(),
      })
      .eq("id", campaign.id);

    if (sentCount === 0) {
      return NextResponse.json(
        {
          success: false,
          campaign_id: campaign.id,
          sent: 0,
          failed: failedCount,
          error: "No messages were delivered. Check template approval, recipient opt-in, and Meta credentials.",
          details: failReasons.slice(0, 5),
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      campaign_id: campaign.id,
      sent: sentCount,
      failed: failedCount,
      partialSuccess: failedCount > 0,
    });
  } catch (err) {
    console.error("Campaign error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to fetch campaigns" }, { status: 500 });
  }
}
