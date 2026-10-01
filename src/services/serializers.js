const statusLabels = {
  pending: "Pendente",
  scheduled: "Agendado",
  qualified: "Qualificado",
  callback: "Retorno",
  no_answer: "Não atendeu",
  no_interest: "Sem interesse",
  invalid: "Número inválido",
};

const auditLabels = {
  confirmed: "Confirmado",
  review: "Revisão",
  not_audited: "Não auditado",
};

function date(value) {
  return value ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(value) : null;
}

function dateTime(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(value).replace(",", "");
}

function shortDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(value).replace(",", "");
}

function phone(value) {
  const match = String(value).match(/^\+55(\d{2})(\d{5})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : value;
}

function serializeCampaign(campaign) {
  return {
    id: campaign.id,
    clientId: campaign.clientId,
    storeId: campaign.storeId,
    name: campaign.name,
    status: campaign.status.toLowerCase(),
    startDate: date(campaign.startDate),
    endDate: date(campaign.endDate),
    receivedLeads: campaign.receivedLeads,
    workedLeads: campaign.workedLeads,
  };
}

function serializeLead(lead) {
  return {
    id: lead.id,
    clientId: lead.clientId,
    campaignId: lead.campaignId,
    name: lead.name,
    initials: lead.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase(),
    phone: phone(lead.phone),
    phoneE164: lead.phone,
    vehicle: lead.vehicle,
    origin: lead.origin,
    reason: lead.reason,
    storeId: lead.storeId,
    store: lead.store,
    campaign: lead.campaign,
    attempts: lead.attempts,
    lastContact: shortDateTime(lead.lastContact),
    createdAt: dateTime(lead.createdAt),
    status: statusLabels[lead.status] || lead.status,
    statusCode: lead.status,
    history: (lead.calls || []).map((call, index) => ({
      id: call.id,
      date: date(call.startedAt),
      time: new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(call.startedAt),
      title: `Tentativa ${index + 1}`,
      detail: call.detail || "Ligação realizada",
      result: statusLabels[call.result] || call.result || "Em andamento",
      durationSec: call.durationSec,
    })),
    callback: lead.callback ? {
      scheduledAt: lead.callback.scheduledAt,
      notes: lead.callback.notes,
    } : null,
    appointment: lead.appointment ? {
      date: date(lead.appointment.date),
      period: lead.appointment.period,
      seller: lead.appointment.seller,
      notes: lead.appointment.notes,
    } : null,
    qualification: lead.qualification ? {
      type: lead.qualification.type,
      date: dateTime(lead.qualification.createdAt),
      notes: lead.qualification.notes,
    } : null,
    audit: lead.audit ? {
      status: auditLabels[lead.audit.status] || lead.audit.status,
      confidence: lead.audit.confidence,
      evidence: lead.audit.evidence,
      auditedAt: dateTime(lead.audit.auditedAt),
    } : { status: "Não auditado" },
    recordingAvailable: Boolean((lead.calls || []).some((call) => call.recordingUrl)),
  };
}

module.exports = { date, dateTime, serializeCampaign, serializeLead, statusLabels };
