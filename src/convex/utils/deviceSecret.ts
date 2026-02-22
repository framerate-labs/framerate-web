export async function hashDeviceSecret(secret: string): Promise<string> {
	const data = new TextEncoder().encode(secret);
	const digest = await crypto.subtle.digest('SHA-256', data);
	const bytes = new Uint8Array(digest);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function verifyDeviceSecret(secret: string, expectedHash: string): Promise<boolean> {
	const actualHash = await hashDeviceSecret(secret);
	return actualHash === expectedHash;
}
