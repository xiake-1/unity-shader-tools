Shader "Gate/Variants/Explicit"
{
  Properties { _MainTex("Tex", 2D) = "white" {} }
  SubShader
  {
    Pass
    {
      Tags { "LightMode"="UniversalForward" }
      HLSLPROGRAM
      #pragma multi_compile A B C
      #pragma shader_feature_local D E
      #pragma multi_compile _ F
      #pragma multi_compile_fwdbase
      #pragma multi_compile_fog
      float4 f(){return 0;}
      ENDHLSL
    }
    Pass
    {
      HLSLPROGRAM
      #pragma multi_compile _ G
      ENDHLSL
    }
  }
  Fallback "Gate/Variants/FallbackTarget"
}
