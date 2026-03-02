/**
 * Extension entry file.
 */
import JSZip from 'jszip';

import * as extensionConfig from '../extension.json';

interface BridgeEnvelope {
	requestId?: string;
	bridgeToken?: string;
}

type SaveFileV2Message = BridgeEnvelope & {
	type: 'pcb-light-paint:saveFileV2';
	fileName?: string;
	blob?: Blob;
};

type SaveZipV2Message = BridgeEnvelope & {
	type: 'pcb-light-paint:saveZipV2';
	zipFileName?: string;
	files?: Array<{ fileName: string; blob: Blob }>;
};

type BuildPcbArtV1Message = BridgeEnvelope & {
	type: 'pcb-light-paint:buildPcbArtV1';
	boardWidthMm?: number;
	boardHeightMm?: number;
	layers?: Array<{
		name?: string;
		layer?: string;
		horizonMirror?: boolean;
		imageWidth?: number;
		imageHeight?: number;
		blob?: Blob;
	}>;
};

type BridgeMessage = SaveFileV2Message | SaveZipV2Message | BuildPcbArtV1Message;

interface HostAckMessage {
	type: 'pcb-light-paint:ackV1';
	requestId?: string;
	forType?: BridgeMessage['type'];
	ok: boolean;
	message: string;
}

interface GlobalBridgeState {
	addEventListener?: (type: string, listener: (event: MessageEvent) => void) => void;
	removeEventListener?: (type: string, listener: (event: MessageEvent) => void) => void;
	__pcbLightPaintMessageHandler?: (event: MessageEvent) => void;
	__pcbLightPaintSeenRequestIds?: Set<string>;
	__pcbLightPaintPcbArtPrimitiveIds?: { outline?: string; images: string[] };
}

const IFRAME_ID = 'pcb-light-paint';
const IFRAME_WIDTH = 1100;
const IFRAME_HEIGHT = 720;
const REQUEST_ID_TTL_MS = 15_000;
const PCB_ART_VECTORIZE_TRIAL = {
	tolerance: 0.45,
	simplification: 0.22,
	smoothing: 0.08,
	despeckling: 1,
};

const TRUSTED_HOST_ORIGIN_PATTERN =
	/^(https:\/\/(pro\.lceda\.cn|pro\.easyeda\.com|prodocs\.lceda\.cn)|http:\/\/localhost(?::\d+)?|app:\/\/|file:\/\/)/i;

const LAYER_ID_BY_KEY: Record<string, number> = {
	TOP: 1,
	BOTTOM: 2,
	TOP_SILKSCREEN: 3,
	BOTTOM_SILKSCREEN: 4,
	TOP_SOLDER_MASK: 5,
	BOTTOM_SOLDER_MASK: 6,
	TOP_PASTE_MASK: 7,
	BOTTOM_PASTE_MASK: 8,
	TOP_ASSEMBLY: 9,
	BOTTOM_ASSEMBLY: 10,
	BOARD_OUTLINE: 11,
};

function getGlobalBridgeState(): GlobalBridgeState {
	return globalThis as unknown as GlobalBridgeState;
}

function mmToMil(mm: number): number {
	return mm / 0.0254;
}

function isTrustedOrigin(origin: string): boolean {
	if (!origin) return false;
	if (origin === 'null') return true;
	return TRUSTED_HOST_ORIGIN_PATTERN.test(origin);
}

function isBridgeMessage(data: unknown): data is BridgeMessage {
	if (!data || typeof data !== 'object') return false;
	const type = (data as { type?: unknown }).type;
	return type === 'pcb-light-paint:saveFileV2' || type === 'pcb-light-paint:saveZipV2' || type === 'pcb-light-paint:buildPcbArtV1';
}

function postAck(event: MessageEvent, payload: HostAckMessage): void {
	const source = event.source as { postMessage?: (message: unknown, targetOrigin?: string) => void } | null;
	if (!source?.postMessage) return;
	const targetOrigin = typeof event.origin === 'string' && event.origin ? event.origin : '*';
	try {
		source.postMessage(payload, targetOrigin);
	} catch {
		try {
			source.postMessage(payload);
		} catch {
			// ignore postMessage fallback failure
		}
	}
}

function ensureMessageBridge(): void {
	const target = getGlobalBridgeState();

	if (!target.__pcbLightPaintSeenRequestIds) target.__pcbLightPaintSeenRequestIds = new Set<string>();
	const seenRequestIds = target.__pcbLightPaintSeenRequestIds;
	if (target.__pcbLightPaintMessageHandler && target.removeEventListener) {
		target.removeEventListener('message', target.__pcbLightPaintMessageHandler);
	}

	target.__pcbLightPaintMessageHandler = (event: MessageEvent) => {
		if (!isTrustedOrigin(event.origin)) return;

		const data = event.data as unknown;
		if (!isBridgeMessage(data)) return;

		const msg = data;
		const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
		const ackBase = {
			type: 'pcb-light-paint:ackV1' as const,
			requestId,
			forType: msg.type,
		};
		const reply = (ok: boolean, message: string): void => {
			postAck(event, { ...ackBase, ok, message });
		};

		if (requestId) {
			if (seenRequestIds.has(requestId)) {
				reply(true, 'Duplicate request ignored.');
				return;
			}
			seenRequestIds.add(requestId);
			setTimeout(() => seenRequestIds.delete(requestId), REQUEST_ID_TTL_MS);
		}

		if (msg.type === 'pcb-light-paint:saveFileV2') {
			void (async () => {
				const fileName = typeof msg.fileName === 'string' ? msg.fileName : undefined;
				const blob = msg.blob;
				if (!blob) {
					reply(false, 'Missing file content.');
					return;
				}
				try {
					await eda.sys_FileSystem.saveFile(blob, fileName);
					reply(true, fileName ? `Saved ${fileName}` : 'Saved file');
				} catch (e) {
					const errorMessage = `Save failed: ${String(e)}`;
					eda.sys_Dialog.showInformationMessage(errorMessage, 'PCB Light Paint');
					reply(false, errorMessage);
				}
			})().catch(() => undefined);
			return;
		}

		if (msg.type === 'pcb-light-paint:buildPcbArtV1') {
			void (async () => {
				const boardWidthMm = typeof msg.boardWidthMm === 'number' ? msg.boardWidthMm : NaN;
				const boardHeightMm = typeof msg.boardHeightMm === 'number' ? msg.boardHeightMm : NaN;
				if (!Number.isFinite(boardWidthMm) || !Number.isFinite(boardHeightMm) || boardWidthMm <= 0 || boardHeightMm <= 0) {
					const errorMessage = 'Invalid board dimensions.';
					eda.sys_Dialog.showInformationMessage(errorMessage, 'PCB Light Paint');
					reply(false, errorMessage);
					return;
				}

				const layers = Array.isArray(msg.layers) ? msg.layers : [];
				if (layers.length === 0) {
					const errorMessage = 'No layer data to build.';
					eda.sys_Dialog.showInformationMessage(errorMessage, 'PCB Light Paint');
					reply(false, errorMessage);
					return;
				}

				const boardW = mmToMil(boardWidthMm);
				const boardH = mmToMil(boardHeightMm);

				if (!target.__pcbLightPaintPcbArtPrimitiveIds) {
					target.__pcbLightPaintPcbArtPrimitiveIds = { images: [] };
				}
				const prev = target.__pcbLightPaintPcbArtPrimitiveIds;
				if (prev.images.length) {
					await eda.pcb_PrimitiveImage.delete(prev.images);
					prev.images = [];
				}
				if (prev.outline) {
					await eda.pcb_PrimitivePolyline.delete(prev.outline);
					prev.outline = undefined;
				}

				await eda.pcb_Document.setCanvasOrigin(0, 0);
				const outlinePolygon = eda.pcb_MathPolygon.createPolygon([0, 0, 'L', boardW, 0, boardW, boardH, 0, boardH]);
				if (!outlinePolygon) {
					const errorMessage = 'Failed to create board outline polygon.';
					eda.sys_Dialog.showInformationMessage(errorMessage, 'PCB Light Paint');
					reply(false, errorMessage);
					return;
				}

				const outline = await eda.pcb_PrimitivePolyline.create('', LAYER_ID_BY_KEY.BOARD_OUTLINE, outlinePolygon, 10, true);
				if (outline) prev.outline = outline.getState_PrimitiveId();

				const imageX = 0;
				const imageY = boardH;
				let createdImagesCount = 0;

				for (const layerItem of layers) {
					const layerKey = typeof layerItem.layer === 'string' ? layerItem.layer : '';
					const layerId = LAYER_ID_BY_KEY[layerKey];
					if (!layerId) continue;

					const blob = layerItem.blob;
					const imageWidth = typeof layerItem.imageWidth === 'number' ? layerItem.imageWidth : NaN;
					const imageHeight = typeof layerItem.imageHeight === 'number' ? layerItem.imageHeight : NaN;
					if (!blob || !Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
						continue;
					}

					try {
						const complexPolygon = await eda.pcb_MathPolygon.convertImageToComplexPolygon(
							blob,
							imageWidth,
							imageHeight,
							PCB_ART_VECTORIZE_TRIAL.tolerance,
							PCB_ART_VECTORIZE_TRIAL.simplification,
							PCB_ART_VECTORIZE_TRIAL.smoothing,
							PCB_ART_VECTORIZE_TRIAL.despeckling,
							true,
							false,
						);
						if (!complexPolygon) continue;

						const horizonMirror = typeof layerItem.horizonMirror === 'boolean' ? layerItem.horizonMirror : false;
						const imagePrimitive = await eda.pcb_PrimitiveImage.create(
							imageX,
							imageY,
							complexPolygon,
							layerId,
							boardW,
							boardH,
							0,
							horizonMirror,
							true,
						);
						if (imagePrimitive) {
							prev.images.push(imagePrimitive.getState_PrimitiveId());
							createdImagesCount++;
						}
					} catch (e) {
						eda.sys_Dialog.showInformationMessage(`Layer ${String(layerItem.name || '')} failed: ${String(e)}`, 'PCB Light Paint');
					}
				}

				await eda.pcb_Document.zoomToBoardOutline();
				const resultMessage =
					createdImagesCount > 0 ? `Generated PCB art primitives (${createdImagesCount} layers).` : 'No PCB art primitive was generated.';
				eda.sys_Dialog.showInformationMessage(resultMessage, 'PCB Light Paint');
				reply(createdImagesCount > 0, resultMessage);
			})().catch((e) => {
				const errorMessage = `Build PCB art failed: ${String(e)}`;
				eda.sys_Dialog.showInformationMessage(errorMessage, 'PCB Light Paint');
				reply(false, errorMessage);
			});
			return;
		}

		void (async () => {
			const zipFileName = typeof msg.zipFileName === 'string' ? msg.zipFileName : 'pcb-light-paint.zip';
			const files = Array.isArray(msg.files) ? msg.files.filter((item) => item?.fileName && item?.blob) : [];
			if (files.length === 0) {
				reply(false, 'No files available for ZIP export.');
				return;
			}

			const zip = new JSZip();
			for (const item of files) {
				zip.file(item.fileName, item.blob);
			}
			const blob = await zip.generateAsync({ type: 'blob' });
			await eda.sys_FileSystem.saveFile(blob, zipFileName);
			reply(true, `Exported ${zipFileName}`);
		})().catch((e) => {
			const errorMessage = `ZIP export failed: ${String(e)}`;
			eda.sys_Dialog.showInformationMessage(errorMessage, 'PCB Light Paint');
			reply(false, errorMessage);
		});
	};

	target.addEventListener?.('message', target.__pcbLightPaintMessageHandler);
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
	void status;
	void arg;
	ensureMessageBridge();
}

export function deactivate(): void {
	const target = getGlobalBridgeState();
	if (target.__pcbLightPaintMessageHandler && target.removeEventListener) {
		target.removeEventListener('message', target.__pcbLightPaintMessageHandler);
	}
	target.__pcbLightPaintMessageHandler = undefined;
	target.__pcbLightPaintSeenRequestIds?.clear();
}

export function openLightPaint(): void {
	ensureMessageBridge();
	try {
		eda.sys_IFrame.openIFrame('/iframe/index.html', IFRAME_WIDTH, IFRAME_HEIGHT, IFRAME_ID, {});
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e || 'openIFrame failed');
		eda.sys_Dialog.showInformationMessage(message, 'PCB Light Paint');
	}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(`PCB Light Paint v${extensionConfig.version}`, 'About');
}
