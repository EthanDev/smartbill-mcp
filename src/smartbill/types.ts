/**
 * Shared SmartBill types (V1 invoice/payment/series/tax + V3).
 * Field names follow the SmartBill API spec (specs/smartbill-api-spec.yaml).
 */

export interface SmartBillClientProduct {
	name: string;
	quantity?: number;
	/** Wire field per spec: `price`, NOT `unitPrice`. */
	price?: number;
	isTaxIncluded?: boolean;
	taxName?: string;
	taxPercentage?: number;
	/** Wire field per spec: `measuringUnitName` (case-sensitive). */
	measuringUnitName?: string;
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
	/** Company CIF that owns the document (SmartBill multi-company accounts REQUIRE it in the body). */
	companyVatCode?: string;
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
	// Convert an existing proforma into an invoice: pull client/products from the estimate.
	estimate?: { seriesName?: string; number?: string };
	useEstimateDetails?: boolean;
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
	/** Wire field: `companyVatCode`, NOT `cif` (SmartBill rejects `cif` with json_mapping_error). */
	companyVatCode: string;
	/** Receipt series (required for Chitanta; unused for Card/OrdinPlata). */
	seriesName?: string;
	/** Invoice to pay; the payment is linked via invoicesList, not top-level number. */
	invoicesList?: { seriesName: string; number: string }[];
	/** Pull client details from the linked invoice (required when no `client` object is sent). */
	useInvoiceDetails?: boolean;
	type: string; // Chitanta|Card|Ordin plata|CEC|Bilet ordin|Mandat postal|Bon|Alta incasare
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

export interface SmartBillEstimateInvoicesResponse {
	areInvoicesCreated?: boolean;
	invoices?: { series: string; number: string }[];
}

export interface SmartBillStockItem {
	warehouseName?: string;
	warehouseType?: string;
	productName?: string;
	productCode?: string;
	measuringUnitName?: string;
	quantity?: number;
}
