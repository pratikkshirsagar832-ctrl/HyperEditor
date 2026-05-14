import React, { useRef, useMemo } from 'react';
import { ThreeCanvas } from '@remotion/three';
import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { useFrame } from '@react-three/fiber';
import { Text, Float, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';

// 3D Scene configuration
export interface Scene3DConfig {
  style: '3d-text' | '3d-logo' | '3d-product' | '3d-particles' | '3d-shapes' | '3d-showcase';
  text?: string;
  subtitle?: string;
  color?: string;
  backgroundColor?: string;
  secondaryColor?: string;
  cameraAnimation?: 'orbit' | 'zoom-in' | 'zoom-out' | 'pan' | 'static';
  intensity?: number;
  shapes?: Array<{
    type: 'cube' | 'sphere' | 'torus' | 'cylinder' | 'cone' | 'dodecahedron' | 'octahedron';
    color?: string;
    position?: [number, number, number];
    scale?: number;
    animation?: 'spin' | 'float' | 'pulse' | 'bounce';
  }>;
}

// Animated 3D Text component using Text from drei (no font file needed)
const AnimatedText3D: React.FC<{ text: string; color: string; position?: [number, number, number] }> = ({
  text,
  color,
  position = [0, 0, 0]
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const safeDuration = Math.max(1, durationInFrames);
  const groupRef = useRef<THREE.Group>(null);

  const entryScale = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 100 },
  });

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.rotation.y = interpolate(frame, [0, safeDuration], [0, Math.PI * 0.3]);
    }
  });

  return (
    <group ref={groupRef} position={position} scale={entryScale}>
      {/* Main text */}
      <Text
        fontSize={1.5}
        color={color}
        anchorX="center"
        anchorY="middle"
        font="https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuGKYAZ9hiA.woff2"
      >
        {text}
        <meshStandardMaterial color={color} metalness={0.6} roughness={0.3} />
      </Text>
      {/* Shadow/depth effect */}
      <Text
        fontSize={1.5}
        color="#000000"
        anchorX="center"
        anchorY="middle"
        position={[0.05, -0.05, -0.1]}
        font="https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuGKYAZ9hiA.woff2"
      >
        {text}
        <meshBasicMaterial color="#000000" transparent opacity={0.3} />
      </Text>
    </group>
  );
};

// Animated 3D Shape component
const AnimatedShape: React.FC<{
  type: string;
  color: string;
  position: [number, number, number];
  scale: number;
  animation: string;
  index: number;
}> = ({ type, color, position, scale, animation, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const meshRef = useRef<THREE.Mesh>(null);

  const entryProgress = spring({
    frame: frame - index * 5,
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  useFrame(() => {
    if (!meshRef.current) return;
    const t = frame / fps;

    // Base rotation
    meshRef.current.rotation.y = t * 0.3;

    switch (animation) {
      case 'spin':
        meshRef.current.rotation.x = t * 0.5;
        meshRef.current.rotation.y = t * 0.8;
        break;
      case 'float':
        meshRef.current.position.y = position[1] + Math.sin(t * 2) * 0.3;
        break;
      case 'pulse': {
        const pulseScale = 1 + Math.sin(t * 3) * 0.1;
        meshRef.current.scale.setScalar(scale * Math.max(0, entryProgress) * pulseScale);
        return; // Don't apply default scale
      }
      case 'bounce':
        meshRef.current.position.y = position[1] + Math.abs(Math.sin(t * 3)) * 0.5;
        break;
    }

    meshRef.current.scale.setScalar(scale * Math.max(0, entryProgress));
  });

  const geometry = useMemo(() => {
    switch (type) {
      case 'sphere':
        return <sphereGeometry args={[0.5, 32, 32]} />;
      case 'torus':
        return <torusGeometry args={[0.4, 0.15, 16, 32]} />;
      case 'cylinder':
        return <cylinderGeometry args={[0.3, 0.3, 0.8, 32]} />;
      case 'cone':
        return <coneGeometry args={[0.4, 0.8, 32]} />;
      case 'dodecahedron':
        return <dodecahedronGeometry args={[0.5]} />;
      case 'octahedron':
        return <octahedronGeometry args={[0.5]} />;
      case 'cube':
      default:
        return <boxGeometry args={[0.7, 0.7, 0.7]} />;
    }
  }, [type]);

  return (
    <mesh ref={meshRef} position={position}>
      {geometry}
      <meshStandardMaterial
        color={color}
        metalness={0.6}
        roughness={0.3}
        emissive={color}
        emissiveIntensity={0.1}
      />
    </mesh>
  );
};

// Floating particles background
const ParticleField: React.FC<{ count: number; color: string }> = ({ count, color }) => {
  const frame = useCurrentFrame();
  const pointsRef = useRef<THREE.Points>(null);

  const particles = useMemo(() => {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
    }
    return positions;
  }, [count]);

  useFrame(() => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y = frame * 0.001;
      pointsRef.current.rotation.x = frame * 0.0005;
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={particles}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial size={0.05} color={color} transparent opacity={0.6} />
    </points>
  );
};

// Product showcase with rotating platform
const ProductShowcase: React.FC<{ color: string; secondaryColor: string }> = ({ color, secondaryColor }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const groupRef = useRef<THREE.Group>(null);

  const entryScale = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 100 },
  });

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.rotation.y = interpolate(frame, [0, durationInFrames], [0, Math.PI * 2]);
    }
  });

  return (
    <group ref={groupRef} scale={Math.max(0, entryScale)}>
      {/* Platform */}
      <mesh position={[0, -1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[2, 2, 0.1, 64]} />
        <meshStandardMaterial color={secondaryColor} metalness={0.9} roughness={0.1} />
      </mesh>

      {/* Main product (stylized cube) */}
      <RoundedBox args={[1.2, 1.2, 1.2]} radius={0.1} smoothness={4} position={[0, 0.2, 0]}>
        <meshStandardMaterial color={color} metalness={0.7} roughness={0.2} />
      </RoundedBox>

      {/* Floating accent shapes */}
      <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
        <mesh position={[1.5, 0.5, 0]}>
          <octahedronGeometry args={[0.2]} />
          <meshStandardMaterial color={secondaryColor} emissive={secondaryColor} emissiveIntensity={0.3} />
        </mesh>
      </Float>
      <Float speed={1.5} rotationIntensity={0.3} floatIntensity={0.8}>
        <mesh position={[-1.5, 0.8, 0.5]}>
          <dodecahedronGeometry args={[0.15]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
        </mesh>
      </Float>
    </group>
  );
};

// Main 3D Scene content
const Scene3DContent: React.FC<{ config: Scene3DConfig }> = ({ config }) => {
  const {
    style,
    text = '3D',
    color = '#f97316',
    secondaryColor = '#3b82f6',
    shapes = [],
  } = config;

  // Default shapes if none provided
  const defaultShapes = [
    { type: 'cube', color, position: [-2, 0, 0] as [number, number, number], scale: 1, animation: 'spin' },
    { type: 'sphere', color: secondaryColor, position: [2, 0, 0] as [number, number, number], scale: 1, animation: 'float' },
    { type: 'torus', color, position: [0, 1.5, 0] as [number, number, number], scale: 0.8, animation: 'spin' },
  ];

  const renderShapes = shapes.length > 0 ? shapes : (style === '3d-shapes' ? defaultShapes : []);

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 5, 5]} intensity={1} />
      <pointLight position={[-5, 5, -5]} intensity={0.5} color={color} />
      <pointLight position={[5, -5, 5]} intensity={0.3} color={secondaryColor} />

      {/* Background particles */}
      {(style === '3d-particles' || style === '3d-showcase') && (
        <ParticleField count={200} color={color} />
      )}

      {/* 3D Text */}
      {(style === '3d-text' || style === '3d-logo') && text && (
        <AnimatedText3D text={text} color={color} />
      )}

      {/* Shapes scene */}
      {(style === '3d-shapes' || style === '3d-particles') && renderShapes.map((shape, index) => (
        <AnimatedShape
          key={index}
          type={shape.type || 'cube'}
          color={shape.color || color}
          position={shape.position || [0, 0, 0]}
          scale={shape.scale || 1}
          animation={shape.animation || 'spin'}
          index={index}
        />
      ))}

      {/* Product showcase */}
      {style === '3d-product' && (
        <ProductShowcase color={color} secondaryColor={secondaryColor} />
      )}

      {/* Showcase (combination) */}
      {style === '3d-showcase' && (
        <>
          <ProductShowcase color={color} secondaryColor={secondaryColor} />
          {renderShapes.map((shape, index) => (
            <AnimatedShape
              key={index}
              type={shape.type || 'cube'}
              color={shape.color || color}
              position={shape.position || [(index - 1) * 2, 2, 0]}
              scale={(shape.scale || 1) * 0.5}
              animation={shape.animation || 'float'}
              index={index}
            />
          ))}
        </>
      )}
    </>
  );
};

// Wrapper component with ThreeCanvas
export const Scene3D: React.FC<{ config: Scene3DConfig }> = ({ config }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const safeDuration = Math.max(1, durationInFrames);

  const backgroundColor = config.backgroundColor || '#0a0a0a';
  const cameraAnimation = config.cameraAnimation || 'orbit';

  // Calculate camera position for orbit
  const orbitAngle = interpolate(frame, [0, safeDuration], [0, Math.PI * 0.5]);
  const cameraX = cameraAnimation === 'orbit' ? Math.sin(orbitAngle) * 5 : 0;
  const cameraZ = cameraAnimation === 'orbit' ? Math.cos(orbitAngle) * 5 :
                  cameraAnimation === 'zoom-in' ? interpolate(frame, [0, safeDuration], [8, 4]) :
                  cameraAnimation === 'zoom-out' ? interpolate(frame, [0, safeDuration], [4, 8]) : 5;

  return (
    <div style={{ width: '100%', height: '100%', background: backgroundColor }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ position: [cameraX, 2, cameraZ], fov: 50 }}
        gl={{ antialias: true }}
      >
        <Scene3DContent config={config} />
      </ThreeCanvas>
    </div>
  );
};

export default Scene3D;
