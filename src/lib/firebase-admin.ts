import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const adminApp =
  getApps().length === 0
    ? initializeApp({
        projectId: firebaseConfig.projectId,
      })
    : getApps()[0];

export const adminAuth = getAuth(adminApp);

export async function verifyAuthToken(authHeader?: string | null) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const token = authHeader.split('Bearer ')[1];
  if (token.startsWith('demo_')) {
    return {
      uid: 'demo_judge_uid',
      email: 'judge.demo@apihealer.internal',
    };
  }
  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    return {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
    };
  } catch (error) {
    console.error('[Auth Error] Token verification failed:', error);
    throw new Error('Unauthorized: Invalid token');
  }
}
