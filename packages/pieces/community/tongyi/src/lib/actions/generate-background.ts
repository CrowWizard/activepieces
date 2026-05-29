import { createAction, Property } from '@activepieces/pieces-framework';
import { tongyiAuth } from '../..';
import { dashScopeClient } from '../common/client';

const MODEL = 'wanx-background-generation-v3';
const SUBMIT_PATH = '/api/v1/services/aigc/background-generation/generation';

export const generateBackground = createAction({
  auth: tongyiAuth,
  name: 'generateBackground',
  displayName: 'Generate Background',
  description:
    'Generate a product image with AI background using a transparent PNG and a text prompt',
  props: {
    imageFile: Property.File({
      displayName: 'Image file',
      description: 'Transparent PNG image of the product',
      required: true,
    }),
    backgroundPrompt: Property.ShortText({
      displayName: 'Background prompt',
      description: 'Description of the desired background scene',
      required: true,
    }),
    filename: Property.ShortText({
      displayName: 'Output filename',
      description: 'Filename for the generated image (without extension)',
      required: true,
    }),
  },
  async run({ auth, propsValue, files }) {
    const apiKey = auth.props.apiKey;
    const imageBase64 = propsValue.imageFile.base64;

    const outputUrl = await dashScopeClient.submitAndWait({
      apiKey,
      model: MODEL,
      submitPath: SUBMIT_PATH,
      input: {
        image_url: `data:image/png;base64,${imageBase64}`,
        prompt: propsValue.backgroundPrompt,
      },
    });

    const imageBuffer = await dashScopeClient.downloadAsBuffer({
      url: outputUrl,
    });

    const savedUrl = await files.write({
      fileName: `${propsValue.filename}.png`,
      data: imageBuffer,
    });

    return {
      fileName: `${propsValue.filename}.png`,
      url: savedUrl,
    };
  },
});
