import { createAction, Property } from '@activepieces/pieces-framework';
import { tongyiAuth } from '../..';
import { dashScopeClient } from '../common/client';

const MODEL = 'wanx2.1-image-pro';
const SUBMIT_PATH = '/api/v1/services/aigc/image2image/image-synthesis';

export const imageProEdit = createAction({
  auth: tongyiAuth,
  name: 'imageProEdit',
  displayName: 'Image Pro Edit',
  description:
    'Edit an image using AI inpainting with a mask and prompt, or enhance image details',
  props: {
    imageFile: Property.File({
      displayName: 'Image file',
      description: 'Source image to edit',
      required: true,
    }),
    editPrompt: Property.ShortText({
      displayName: 'Edit prompt',
      description: 'Description of the desired edit or enhancement',
      required: true,
    }),
    maskFile: Property.File({
      displayName: 'Mask file',
      description:
        'Black-and-white mask image (white = area to repaint). Optional — if omitted, full-image edit is performed',
      required: false,
    }),
    filename: Property.ShortText({
      displayName: 'Output filename',
      description: 'Filename for the edited image (without extension)',
      required: true,
    }),
  },
  async run({ auth, propsValue, files }) {
    const apiKey = auth.props.apiKey;
    const imageBase64 = propsValue.imageFile.base64;

    const input: Record<string, unknown> = {
      image_url: `data:image/png;base64,${imageBase64}`,
      prompt: propsValue.editPrompt,
    };

    if (propsValue.maskFile) {
      input['mask_url'] = `data:image/png;base64,${propsValue.maskFile.base64}`;
    }

    const outputUrl = await dashScopeClient.submitAndWait({
      apiKey,
      model: MODEL,
      submitPath: SUBMIT_PATH,
      input,
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
