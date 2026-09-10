import { createAction, Property } from '@activepieces/pieces-framework';
import { tongyiAuth } from '../..';
import { dashScopeClient } from '../common/client';

const MODEL = 'wanx-segmentation-matting';
const SUBMIT_PATH = '/api/v1/services/aigc/image-segmentation/generation';

export const removeBackground = createAction({
  auth: tongyiAuth,
  name: 'removeBackground',
  displayName: 'Remove Background',
  description:
    'Remove image background and produce a transparent PNG using AI segmentation',
  props: {
    imageFile: Property.File({
      displayName: 'Image file',
      description: 'Image to remove background from',
      required: true,
    }),
    filename: Property.ShortText({
      displayName: 'Output filename',
      description: 'Filename for the generated image (without extension)',
      required: true,
    }),
  },
  async run({ auth, propsValue, files }) {
    return dashScopeClient.submitAndSaveImage({
      apiKey: auth.props.apiKey,
      model: MODEL,
      submitPath: SUBMIT_PATH,
      input: {
        image_url: `data:image/png;base64,${propsValue.imageFile.base64}`,
      },
      parameters: {
        output_type: 'transparent',
      },
      filename: propsValue.filename,
      files,
    });
  },
});
