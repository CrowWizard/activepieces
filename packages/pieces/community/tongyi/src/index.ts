import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { generateBackground } from './lib/actions/generate-background';
import { imageProEdit } from './lib/actions/image-pro-edit';

export const tongyiAuth = PieceAuth.CustomAuth({
  required: true,
  props: {
    apiKey: PieceAuth.SecretText({
      displayName: 'API key',
      description: 'DashScope API key from Alibaba Cloud',
      required: true,
    }),
  },
});

export const tongyi = createPiece({
  displayName: 'Tongyi Wanxiang',
  auth: tongyiAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: 'https://cdn.activepieces.com/pieces/tongyi.png',
  authors: [],
  actions: [generateBackground, imageProEdit],
  triggers: [],
});
