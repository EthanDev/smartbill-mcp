/**
 * Shared SmartBill types (V1 invoice/payment/series/tax + V3).
 * Field names follow the SmartBill API spec (specs/smartbill-api-spec.yaml).
 */

export interface SmartBillClientProduct {
	name: string;
	quantity?: number;
	unitPrice?: number;
	isTaxIncluded?: boolean;
	taxName?: string;
	taxPercentage?: number;
	measureUnit?: string;
	description?: string;
}

export interface SmartBillClientDoc {
	name: string;
	cif?: string;
	vatCode?: string;
	regCom?: string;
	address?: string;
	city?: string;
	country?: string;
	email?: string;
	phone?: string;
	id?: number;
}

export interface SmartBillCreateInvoiceBody {
	seriesName?: string;
	number?: string;
	isDraft?: boolean;
	issueDate?: string; // yyyy-MM-dd
	dueDate?: string;
	currency?: string;
	client?: SmartBillClientDoc;
	products?: SmartBillClientProduct[];
	cancelInvoice?: boolean;
	// Optional estimate fields
	estimateType?: string;
	// Server resolves these if absent
	// language, precision, etc. omitted for simplicity
}

export interface SmartBillDocumentResponse {
	seriesName?: string;
	number?: string;
	documentUrl?: string;
	info?: Record<string, unknown>;
	code?: number;
	message?: string;
}

export interface SmartBillSendDocumentBody {
	cif?: string;
	type?: string; // factura|proforma|... case-insensitive
	seriesName?: string;
	number?: string;
	to: string;
	toExternal?: boolean;
	cc?: string;
	subject?: string;
	bodyText?: string; // base64-encoded per spec
	channels?: ("email" | "sms")[];
}

export interface SmartBillPaymentBody {
	cif: string;
	seriesName: string;
	number: string;
	type: string; // Chitanta|Card|OrdinPlata|CEC|BiletOrdin|MandatPostal|BonFiscal|AltaIncasare
	value: number;
	currency?: string;
}

export interface SmartBillPaymentStatusResponse {
	isPaid?: boolean;
	hasProvision?: boolean;
	code?: number;
	message?: string;
}

export interface SmartBillSeriesItem {
	/** Field is `name` in the live /series response (e.g. "SR"). */
	name?: string;
	type?: string;
	isDraft?: boolean;
	nextNumber?: string;
}

export interface SmartBillTaxItem {
	percentage?: number;
	name?: string;
}
