// water-shader.ts — Custom ShaderMaterial for water with animated reflections.
// Uses a simple normal-mapping approximation + fresnel for a reflective look.

import * as THREE from 'three';

export function createWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x2a5a8a) },
      uDeepColor: { value: new THREE.Color(0x0a2a4a) },
      uOpacity: { value: 0.7 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uDeepColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;

      // Simple hash-based noise
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1, 0)), f.x),
          mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x),
          f.y
        );
      }

      void main() {
        // Animated water surface — multiple wave layers
        float t = uTime * 0.5;
        float w1 = noise(vUv * 8.0 + vec2(t, t * 0.7));
        float w2 = noise(vUv * 16.0 + vec2(-t * 0.5, t));
        float w3 = noise(vUv * 32.0 + vec2(t * 0.3, -t * 0.8));
        float waves = (w1 * 0.5 + w2 * 0.3 + w3 * 0.2);

        // Fresnel — brighter at grazing angles
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float fresnel = pow(1.0 - abs(dot(vNormal, viewDir)), 3.0);
        fresnel = mix(0.2, 1.0, fresnel);

        // Mix shallow and deep color based on wave height
        vec3 color = mix(uDeepColor, uColor, waves);
        // Add specular highlight from wave peaks
        float specular = pow(waves, 8.0) * 0.5;
        color += vec3(specular) * fresnel;

        // Add a subtle sky tint reflection (fake)
        color = mix(color, vec3(0.4, 0.5, 0.7), fresnel * 0.15);

        gl_FragColor = vec4(color, uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function createLavaMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0xff4a1a) },
      uDeepColor: { value: new THREE.Color(0x6a1a0a) },
      uOpacity: { value: 0.75 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uDeepColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1, 0)), f.x),
          mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x),
          f.y
        );
      }

      void main() {
        // Lava churns faster and more violently
        float t = uTime * 1.5;
        float w1 = noise(vUv * 6.0 + vec2(t, -t * 0.5));
        float w2 = noise(vUv * 12.0 + vec2(-t * 0.7, t * 0.8));
        float w3 = noise(vUv * 24.0 + vec2(t * 0.4, t * 0.6));
        float churn = (w1 * 0.4 + w2 * 0.35 + w3 * 0.25);

        vec3 color = mix(uDeepColor, uColor, churn);
        // Bright glowing cracks
        float cracks = pow(churn, 4.0);
        color += vec3(cracks * 1.5, cracks * 0.5, 0.0);

        gl_FragColor = vec4(color, uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}
