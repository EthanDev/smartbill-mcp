import { z } from "zod";

/** MUST be `true` — the machine-side confirm gate for every committal tool. */
const confirm = z.literal(true);

const productSchema = z.object({
	name: z.string().min(1),
	quantity: z.number().positive().optional(),
	unitPrice: z.number().optional(),
	isTaxIncluded: z.boolean().optional(),
	taxName: z.string().optional(),
	taxPercentage: z.number().optional(),
	description: z.string().optional(),
});

const clientSchema = z.object({
	name: z.string().min(1),
	cif: z.string().optional(),
	vatCode: z.string().optional(),
	regCom: z.string().optional(),
	address: z.string().optional(),
	city: z.string().optional(),
	country: z.string().optional(),
	email: z.string().email().optional(),
	phone: z.string().optional(),
});

export const createDraftSchema = z.object({
	client: clientSchema.optional(),
	client_id: z.number().optional(),
	products: z.array(productSchema).min(1).optional(),
	series: z.string().optional(),
	issueDate: z.string().optional(),
	dueDate: z.string().optional(),
	currency: z.string().optional(),
	idempotency_key: z.string().optional(),
});

export const finalizeInvoiceSchema = z.object({
	draft_id: z.string(),
	confirm,
});

export const sendInvoiceSchema = z.object({
	draft_id: z.string().optional(),
	series: z.string().optional(),
	number: z.string().optional(),
	to: z.string().email().optional(),
	cc: z.string().optional(),
	subject: z.string().optional(),
	bodyText: z.string().optional(),
	confirm,
});

export const recordPaymentSchema = z.object({
	series: z.string(),
	number: z.string(),
	type: z.enum(["Chitanta", "Card", "OrdinPlata", "CEC", "BiletOrdin", "MandatPostal", "BonFiscal", "AltaIncasare"]),
	value: z.number().nonnegative(),
	currency: z.string().optional(),
	confirm,
});

export const cancelInvoiceSchema = z.object({ series: z.string(), number: z.string(), confirm });
export const stornoSchema = z.object({ series: z.string(), number: z.string(), confirm });

export const invoiceStatusSchema = z.object({ series: z.string(), number: z.string() });
export const getPdfSchema = z.object({ series: z.string(), number: z.string() });
export const listSeriesSchema = z.object({ type: z.string().optional() });
export const listTaxSchema = z.object({});
export const listClientsSchema = z.object({ name: z.string().optional(), limit: z.number().int().positive().max(100).optional() });
export const listProductsSchema = z.object({ name: z.string().optional(), code: z.string().optional(), limit: z.number().int().positive().max(100).optional() });
export const searchInvoicesSchema = z.object({
	client: z.string().optional(),
	status: z.enum(["draft", "issued", "sent", "paid", "cancelled", "storno"]).optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	text: z.string().optional(),
});
export const countTotalsSchema = z.object({
	month: z.string().optional(),
	client: z.string().optional(),
	status: z.enum(["draft", "issued", "sent", "paid", "cancelled", "storno"]).optional(),
});
export const registerAccountSchema = z.object({
	email: z.string().email(),
	token: z.string().min(1),
	cif: z.string().min(1),
	cif_fallback: z.string().optional(),
	overwrite: z.boolean().default(false),
});
