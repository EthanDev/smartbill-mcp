import { describe, it, expect } from "vitest";
import { V3Client, V3NotConfiguredError } from "../../src/smartbill/v3";
import type { FetchLike } from "../../src/smartbill/client";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

describe("V3Client", () => {
	it("returns the typed V3NotConfiguredError when no token is configured (not a raw 401)", async () => {
		const fn: FetchLike = () => Promise.resolve(new Response());
		const client = new V3Client({ cif: "RO47247261", fetchFn: fn as FetchLike });
		await expect(client.listClients("RO47247261")).rejects.toBeInstanceOf(V3NotConfiguredError);
		await expect(client.listProducts("RO47247261")).rejects.toBeInstanceOf(V3NotConfiguredError);
	});

	it("listClients hits /v3/companies/{cif}/clients and parses the clients array", async () => {
		const fn: FetchLike = (url: string) =>
			Promise.resolve(jsonResponse(200, { clients: [{ id: 1, name: "ACME SRL", code: "ACME" }] }));
		const client = new V3Client({ cif: "RO47247261", token: "v3token", fetchFn: fn as FetchLike });
		const result = await client.listClients("RO47247261", "ACME", 5);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("ACME SRL");
	});

	it("listProducts parses the products array", async () => {
		const fn: FetchLike = () =>
			Promise.resolve(jsonResponse(200, { products: [{ id: 9, name: "Consultanta", code: "SVC" }] }));
		const client = new V3Client({ cif: "RO47247261", token: "v3token", fetchFn: fn as FetchLike });
		const result = await client.listProducts("RO47247261", "Consultanta");
		expect(result[0]).toMatchObject({ id: 9, name: "Consultanta" });
	});

	it("sends a Bearer token header", async () => {
		let authHeader = "";
		const fn: FetchLike = (url: string, init?: RequestInit) => {
			authHeader = (init?.headers as Record<string, string>).Authorization ?? "";
			return Promise.resolve(jsonResponse(200, { clients: [] }));
		};
		const client = new V3Client({ cif: "RO47247261", token: "v3token", fetchFn: fn as FetchLike });
		await client.listClients("RO47247261");
		expect(authHeader).toBe("Bearer v3token");
	});

	it("follows pagination.next (full URL) until null", async () => {
		const urls: string[] = [];
		const fn: FetchLike = (url: string) => {
			urls.push(String(url));
			const page = urls.length;
			if (page === 1) {
				return Promise.resolve(jsonResponse(200, { items: [{ id: "cus_1", name: "A" }], pagination: { next: "https://ws.smartbill.ro/SBORO/api/v3/companies/RO47247261/clients?limit=2&after=cus_1", previous: null } }));
			}
			return Promise.resolve(jsonResponse(200, { items: [{ id: "cus_2", name: "B" }], pagination: { next: null, previous: "..." } }));
		};
		const client = new V3Client({ cif: "RO47247261", token: "v3token", fetchFn: fn as FetchLike });
		const result = await client.listClients("RO47247261", undefined, 2);
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.name)).toEqual(["A", "B"]);
		expect(urls).toHaveLength(2);
		expect(urls[1]).toContain("after=cus_1"); // followed the cursor URL
	});
});
