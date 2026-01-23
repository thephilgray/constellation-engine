import { Amplify } from 'aws-amplify';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.PUBLIC_USER_POOL_ID,
      userPoolClientId: import.meta.env.PUBLIC_USER_POOL_CLIENT_ID,
    },
  },
});

export const API_URL = import.meta.env.PUBLIC_API_URL;
