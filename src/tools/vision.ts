import { routeAiCompletion, routeAiVisionCompletion } from '../ai/providers.js';
import { OpenArvaRouter } from '../ai/router.js';

export async function analyzeImage(imageBuffer: Buffer, prompt: string): Promise<string> {
  const mimeType = imageBuffer.subarray(0, 8).toString('hex').startsWith('89504e470d0a1a0a')
    ? 'image/png'
    : imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8
      ? 'image/jpeg'
      : imageBuffer.toString('ascii', 0, 4) === 'RIFF' && imageBuffer.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : imageBuffer.toString('ascii', 0, 6).startsWith('GIF8')
          ? 'image/gif'
          : undefined;
  if (!mimeType) throw new Error('Unsupported image format. Use PNG, JPEG, WebP, or GIF.');
  if (imageBuffer.byteLength > 10 * 1024 * 1024) throw new Error('Image exceeds the 10 MB analysis limit.');
  return (await routeAiVisionCompletion(prompt, imageBuffer, mimeType)).text;
}

export async function generateArtPrompt(description: string): Promise<string> {
  const route = OpenArvaRouter.resolveTaskRoute('fast');
  return routeAiCompletion(`Write a concise, visual image-generation prompt from this description. Return only the prompt; do not claim to generate an image.\n\nDescription: ${description}`, route.provider, route.model);
}