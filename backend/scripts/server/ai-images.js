/**
 * AI image generation via fal.ai.
 * Consolidated from ai-client.js.
 */
import fs from 'fs';

/**
 * Generate an image using fal.ai FLUX.1 schnell.
 * @param {string} prompt
 * @param {string} outputPath
 * @returns {Promise<boolean>}
 */
export async function generateImageWithFal(prompt, outputPath) {
  const { fal } = await import('@fal-ai/client');

  const result = await fal.run('fal-ai/flux/schnell', {
    input: {
      prompt,
      num_images: 1,
      image_size: 'square_hd',
      output_format: 'png',
    },
  });

  const imageUrl = result.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error('No image returned from fal.ai');

  const imgResponse = await fetch(imageUrl);
  if (!imgResponse.ok) throw new Error(`Failed to download image: ${imgResponse.status}`);

  const arrayBuffer = await imgResponse.arrayBuffer();
  await fs.promises.writeFile(outputPath, Buffer.from(arrayBuffer));
  return true;
}
