/**
 * MCP write tool — crm_add_lead_note.
 *
 * A linha do tempo do negócio já tem o tipo `note` ("Anotação"), desenhado
 * por `LeadTimeline` e pela timeline do contato a partir de `reason`. Não
 * havia porta de escrita: o agente só deixava texto no `reason` de
 * `crm_move_lead_stage`, que também muda a etapa.
 *
 * A linha é montada por `buildLeadActivityRow` — a mesma regra de autoria do
 * resto do barramento (ator `ai` sem lastro de run entra como sistema, para
 * o INSERT não morrer na constraint). A nota É o efeito, então falha de
 * gravação sobe; não usa o `emitLeadActivity`, que é de propósito
 * fire-and-forget para não derrubar a operação que descreve.
 */
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import type { McpContext, McpToolDefinition } from "../types";

const inputShape = {
  lead_id: z.string().uuid().describe("UUID do negócio (lead)."),
  note: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe("Texto da anotação. Aparece na linha do tempo do negócio como Anotação."),
};

function atorDaNota(ctx: McpContext): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (ctx.actor.type === "user") {
    return { actorUserId: ctx.actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: { actor_type: ctx.actor.type, actor_id: ctx.actor.id },
  };
}

export const crmAddLeadNote: McpToolDefinition<typeof inputShape> = {
  name: "crm_add_lead_note",
  description:
    "Acrescenta uma anotação de texto livre na linha do tempo de um negócio (tipo note, rótulo Anotação). " +
    "Não move etapa, não envia mensagem e não altera campos do negócio. " +
    "O texto aparece para a equipe na timeline do negócio e, se o negócio tiver contato, na timeline do contato. " +
    "Devolve note_id. Erros: negócio inexistente nesta organização; contato do negócio marcado como pessoal.",
  inputSchema: inputShape,
  category: "write",
  // Igual a `crm_add_case_note` e `crm_update_lead`: anotação não destrói.
  // Papel `manager` deixaria a ferramenta fora do alcance do agente publicado.
  requiresRole: "agent",
  requiresScope: "mcp:write",
  redigirParaAuditoria: (args) => ({
    ...args,
    note: typeof args.note === "string" ? `[redacted:${args.note.length}]` : args.note,
  }),
  handler: async (input, ctx) => {
    const { data: negocio, error: leitura } = await ctx.supabase
      .from("crm_leads")
      .select("id, contact_id")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.lead_id)
      .maybeSingle();
    if (leitura)
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, leitura.message);
    if (!negocio) {
      throw new ApiError(
        404,
        "not_found",
        undefined,
        ctx.requestId,
        "Negócio não encontrado nesta organização.",
      );
    }

    const contactId = (negocio as { contact_id?: string | null }).contact_id ?? null;
    if (contactId) {
      const { data: contato, error: erroContato } = await ctx.supabase
        .from("contacts")
        .select("is_personal")
        .eq("organization_id", ctx.organizationId)
        .eq("id", contactId)
        .maybeSingle();
      if (erroContato) {
        throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroContato.message);
      }
      if ((contato as { is_personal?: boolean } | null)?.is_personal === true) {
        return {
          permitido: false,
          motivo: "contato_pessoal",
          mensagem:
            "este negócio é de um contato marcado como pessoal — fora da operação: não anote aqui.",
        };
      }
    }

    const row = buildLeadActivityRow({
      organizationId: ctx.organizationId,
      leadId: input.lead_id,
      contactId,
      type: "note",
      sourceModule: "crm",
      actor: ctx.actor,
      reason: input.note,
      payload: { body: input.note },
    });

    const { data: gravada, error } = await ctx.supabase
      .from("crm_lead_activities")
      .insert(row)
      .select("id")
      .single();
    if (error || !gravada) {
      throw new ApiError(
        500,
        "internal_error",
        undefined,
        ctx.requestId,
        error?.message ?? "Não foi possível gravar a anotação.",
      );
    }

    const noteId = (gravada as { id: string }).id;
    const a = atorDaNota(ctx);
    await audit({
      action: "lead.note_added",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "crm_lead_activity",
      resourceId: noteId,
      requestId: ctx.requestId,
      metadata: {
        ...a.metadataActor,
        via: "mcp",
        lead_id: input.lead_id,
        chars: input.note.length,
      },
    });

    return { note_id: noteId, lead_id: input.lead_id };
  },
};
